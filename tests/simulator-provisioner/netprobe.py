#!/usr/bin/env python3
import argparse
import json
import os
import pwd
import re
import socket
import socketserver
import subprocess
import threading
import time
import uuid
from pathlib import Path

from provision import clean_environment, digest, regular, require, write_new


def packet_count(text, label):
    values = re.findall(r'label "' + re.escape(label) + r'"[^\n]*\n\s*\[\s*Evaluations:.*?Packets:\s*(\d+)', text)
    require(bool(values), "kernel PF counter missing for " + label)
    return sum(int(value) for value in values)


def dns_filter(nonce):
    require(re.fullmatch(r"[a-f0-9]{32}", nonce), "bounded unique DNS query nonce required")
    words = []
    for offset in range(0, 32, 4):
        word = int.from_bytes(nonce[offset:offset + 4].encode(), "big") & 0xdfdfdfdf
        words.append(f"(udp[{21 + offset}:4] & 0xdfdfdfdf) = 0x{word:08x}")
    return "udp dst port 53 and udp[20] = 32 and " + " and ".join(words)


class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.sendall(self.request.recv(128))


class UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data, connection = self.request
        connection.sendto(data, self.client_address)


def verify_loopback():
    records = []
    for family, address, suffix in ((socket.AF_INET, "127.0.0.1", "4"), (socket.AF_INET6, "::1", "6")):
        for kind, base, handler, protocol in ((socket.SOCK_STREAM, socketserver.ThreadingTCPServer, TCPHandler, "tcp"),
                                               (socket.SOCK_DGRAM, socketserver.ThreadingUDPServer, UDPHandler, "udp")):
            server_class = type("RunOwnedEcho", (base,), {"address_family": family, "daemon_threads": True})
            server = server_class((address, 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                nonce = uuid.uuid4().hex.encode()
                with socket.socket(family, kind) as client:
                    client.settimeout(2)
                    client.connect((address, server.server_address[1]))
                    client.sendall(nonce)
                    require(client.recv(128) == nonce, "actual loopback echo did not round trip")
                records.append({"family": "ipv" + suffix, "protocol": protocol, "address": address, "port": server.server_address[1], "echoVerified": True})
            finally:
                server.shutdown()
                server.server_close()
    return records


class NetworkProbe:
    def __init__(self, folder, run):
        self.folder = Path(folder)
        self.run = str(uuid.UUID(run)).upper()
        self.name = "zzzz_calledit_" + uuid.UUID(self.run).hex
        self.anchor = "com.apple/" + self.name
        self.environment = clean_environment(Path.home(), self.folder)

    def command(self, argv, timeout=10, check=True):
        result = subprocess.run(argv, env=self.environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
        require(not check or result.returncode == 0, "kernel probe command failed: " + " ".join(argv[:3]))
        return result.stdout.decode()

    def counters(self):
        return self.command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-a", self.anchor, "-vvsr"])

    def control_continuity(self):
        from launch_provenance import root_launch_witness, verify_trusted_launch
        from vsock_control import live_control
        ready = json.loads(regular(str(self.folder / "lease-ready.json")))
        authorization = verify_trusted_launch(ready["launchContext"], ready["launchContextSHA256"], self.run)
        _, witness_sha = root_launch_witness(authorization, ready["leasePID"])
        observed = live_control(ready, authorization, witness_sha, self.command)
        require(observed["outputDirectory"] == str(self.folder), "network probe belongs to another immutable run directory")
        return observed

    def raw_denials(self):
        results = []
        for family, address, suffix in ((socket.AF_INET, "198.51.100.77", "4"), (socket.AF_INET6, "2001:db8::77", "6")):
            for kind, protocol in ((socket.SOCK_STREAM, "tcp"), (socket.SOCK_DGRAM, "udp")):
                label = self.name + "_probe_" + protocol + suffix
                before = self.counters()
                connected = False
                error = None
                with socket.socket(family, kind) as client:
                    client.settimeout(2)
                    try:
                        client.connect((address, 65432))
                        if kind == socket.SOCK_STREAM:
                            connected = True
                        else:
                            client.send(self.run.encode())
                    except OSError as failure:
                        error = failure.errno
                after = self.counters()
                difference = packet_count(after, label) - packet_count(before, label)
                require(not connected and difference > 0,
                        "no attributable kernel " + protocol + suffix + " drop; errno=" + str(error) + " is not itself proof (including no-route/timeout)")
                results.append({"family": "ipv" + suffix, "protocol": protocol, "target": address, "port": 65432,
                                "errno": error, "kernelDropDelta": difference, "before": before, "after": after, "mechanism": "kernel-pf-drop"})
        return results

    def broker_denial(self):
        nonce = uuid.uuid4().hex
        hostname = nonce + ".example.com"
        path = self.folder / "resolver-blocked.pcap"
        require(not path.exists() and path.parent.resolve() == path.parent, "fresh owned DNS capture required")
        capture = subprocess.Popen(["/usr/bin/sudo", "-n", "/usr/sbin/tcpdump", "-Z", pwd.getpwuid(os.getuid()).pw_name,
                                    "-i", "pflog0", "-n", "-U", "-s", "0", "-w", str(path), dns_filter(nonce)],
                                   env=self.environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(0.5)
            require(capture.poll() is None, "PFLOG capture unavailable; no resolver/broker denial proof")
            before = self.counters()
            resolver = subprocess.Popen(["/usr/bin/dscacheutil", "-q", "host", "-a", "name", hostname],
                                        env=self.environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            resolver_pid = resolver.pid
            try:
                stdout, stderr = resolver.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                resolver.kill()
                stdout, stderr = resolver.communicate(timeout=3)
            time.sleep(0.5)
            after = self.counters()
        finally:
            if capture.poll() is None:
                self.command(["/usr/bin/sudo", "-n", "/bin/kill", "-INT", str(capture.pid)], check=False)
            try:
                capture.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                self.command(["/usr/bin/sudo", "-n", "/bin/kill", "-KILL", str(capture.pid)], check=False)
                capture.communicate(timeout=3)
        raw = regular(str(path), 1_048_576)
        decoded = self.command(["/usr/sbin/tcpdump", "-n", "-e", "-vv", "-r", str(path)])
        require(hostname in decoded.lower() and "block out" in decoded.lower(),
                "system resolver produced no uniquely attributable kernel-blocked DNS packet; cached NXDOMAIN/no-route is unproven")
        label = self.name + "_dns"
        difference = packet_count(after, label) - packet_count(before, label)
        require(difference > 0, "actual broker packet has no matching live DNS-deny counter")
        return {"hostname": hostname, "resolverProgram": "/usr/bin/dscacheutil", "resolverPID": resolver_pid,
                "stdoutSHA256": digest(stdout), "stderrSHA256": digest(stderr), "exit": resolver.returncode,
                "pcapFile": path.name, "pcapSHA256": digest(raw), "decodedOwnedQuery": decoded,
                "kernelDropDelta": difference, "before": before, "after": after, "mechanism": "kernel-pf-log-block-out"}

    def run_probe(self):
        ready = json.loads(regular(str(self.folder / "lease-ready.json")))
        require(ready["runID"] == self.run and ready["anchor"] == self.anchor, "actual independent lease not ready")
        continuity = self.control_continuity()
        loopback = verify_loopback()
        raw = self.raw_denials()
        broker = self.broker_denial()
        after_control = self.control_continuity()
        write_new(self.folder / "network-verified.json", {"runID": self.run, "probePID": os.getpid(), "uid": os.getuid(),
                  "verifiedAt": int(time.time() * 1000),
                  "controller": continuity, "controllerAfterDenials": after_control, "loopback": loopback, "rawNonlocal": raw, "resolverBroker": broker,
                  "coverage": "global stateless IP policy, zero external IP allows; intentional provider vsock management; no arbitrary non-IP/covert-channel coverage or inferred external delivery"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    NetworkProbe(args.directory, args.run_id).run_probe()


if __name__ == "__main__":
    main()
