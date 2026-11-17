#!/usr/bin/env python3
import argparse
import json
import os
import platform
import pwd
import plistlib
import re
import subprocess
import time
import uuid
from pathlib import Path

from provision import clean_environment, digest, regular, require
from launch_provenance import root_launch_witness, verify_trusted_launch
from vsock_control import fingerprint_paths, live_control
from root_capsule import capsule_info


def source_fingerprints():
    return {name: digest(regular(str(path))) for name, path in fingerprint_paths().items()}


def live_status(folder, run_id, owner_pid):
    require(platform.system() == "Darwin", "real macOS kernel isolation required")
    capsule_metadata = capsule_info()
    require(os.geteuid() == 0 and capsule_metadata is not None, "live status must execute only the verified isolated read-only root capsule")
    folder = Path(folder)
    run = str(uuid.UUID(run_id)).upper()
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    environment = clean_environment(home, folder)
    def command(argv):
        result = subprocess.run(argv, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        require(result.returncode == 0, "live isolation query failed")
        return result.stdout.decode()
    for marker in ("lease-cleanup.json", "lease-blocked.json", "lease-stop.json"):
        require(not (folder / marker).exists(), "independent isolation is stopping or no longer valid")
    ready_raw = regular(str(Path(capsule_metadata["directory"]) / "root-records/lease-ready.json"))
    require(regular(str(folder / "lease-ready.json")) == ready_raw, "workload-owned ready copy differs from the authoritative root record")
    ready = json.loads(ready_raw)
    require(ready["runID"] == run and ready["ownerPID"] == owner_pid, "live controller identity mismatch")
    require(int(time.time() * 1000) < ready["leaseExpiresAt"], "independent isolation lease expired")
    private_context = capsule_metadata["info"]["privateContextPath"]
    require(ready["rootAuthorityContextPath"] == private_context, "immutable root authority context mismatch")
    authorization = verify_trusted_launch(private_context, ready["launchContextSHA256"], run)
    require(authorization["chainSHA256"] == ready["runnerAuthorization"]["chainSHA256"],
            "live platform launch authority changed")
    witness, witness_hash = root_launch_witness(authorization, ready["leasePID"])
    require(witness["rootGuard"]["birth"] == ready["leaseIdentity"]["birth"] and witness["consumedAt"] <= ready["recordedAt"],
            "independent root launch consumption must precede this exact lease/process")
    heartbeat = json.loads(regular(str(folder / "heartbeat.json"), 4096))
    require(heartbeat["runID"] == run and 0 <= time.time() - (folder / "heartbeat.json").stat().st_mtime < 8, "live controller heartbeat is stale")
    pid = ready["leasePID"]
    uid = command(["/bin/ps", "-p", str(pid), "-o", "uid="]).strip()
    birth = " ".join(command(["/bin/ps", "-p", str(pid), "-o", "lstart="]).split())
    arguments = command(["/usr/bin/sudo", "-n", "/bin/ps", "-p", str(pid), "-o", "args="])
    capsule = "/private/var/run/calledit-qa-capsules/" + authorization["launchNonce"]
    require(witness["rootGuard"].get("capsuleDirectory") == capsule and
            ready["leaseProgram"] == capsule + "/tests/simulator-provisioner/lease.py", "actual root lease is not the immutable capsule program")
    capsule_info_path = capsule + "/capsule-info.json"
    capsule_info_raw = command(["/usr/bin/sudo", "-n", "/bin/cat", capsule_info_path]).encode()
    require(digest(capsule_info_raw) == witness["rootGuard"]["capsuleInfoSHA256"] and
            json.loads(capsule_info_raw)["contextSHA256"] == authorization["contextSHA256"], "root capsule seal changed")
    require(uid == "0" and birth == ready["leaseIdentity"]["birth"] and ready["leaseProgram"] in arguments and
            str(folder) in arguments and run in arguments, "independent root lease process is absent or reused")
    require(command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-sr"]) == ready["rootRules"], "root PF policy changed")
    require(ready["anchor"] == "com.apple/zzzz_calledit_" + uuid.UUID(run).hex and
            command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-a", ready["anchor"], "-sr"]) == ready["activeRules"], "run-owned PF policy changed")
    require(command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-a", "*", "-sr"]) == ready["activeFilterTree"] and
            command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-a", "*", "-sn"]) == ready["baselineTranslationTree"], "nested PF policy changed")
    require("Enabled" in command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-s", "info"]) and
            not command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-ss"]).strip(), "PF disabled or unexpected state can bypass the stateless policy")
    controller = live_control(ready, authorization, witness_hash, command)
    require(controller["outputDirectory"] == str(folder), "live status directory is not the immutable run directory")
    owner_uid = command(["/bin/ps", "-p", str(owner_pid), "-o", "uid="]).strip()
    require(owner_uid.isdecimal() and int(owner_uid) > 0 and int(owner_uid) == controller["ownerUID"], "actual owner UID differs from immutable root control evidence")
    home = Path(pwd.getpwuid(int(owner_uid)).pw_dir)
    environment = clean_environment(home, folder)
    proof_raw = regular(str(folder / "network-verified.json"))
    proof = json.loads(proof_raw)
    require(proof["runID"] == run and ready["recordedAt"] <= proof["verifiedAt"] <= int(time.time() * 1000),
            "kernel proof must follow this nonce/boot-bound lease, not a previous run")
    require(proof["controller"]["rootControlWitnessSHA256"] == ready["controlRuntimeSHA256"], "kernel probe used another controller profile/witness")
    broker = proof["resolverBroker"]
    require(broker["pcapFile"] == "resolver-blocked.pcap", "unrecognized broker capture path")
    capture = regular(str(folder / "resolver-blocked.pcap"))
    require(digest(capture) == broker["pcapSHA256"], "owned blocked DNS capture changed")
    decoded = command(["/usr/sbin/tcpdump", "-n", "-e", "-vv", "-r", str(folder / "resolver-blocked.pcap")]).lower()
    require(broker["hostname"] in decoded and "block out" in decoded, "actual kernel broker block is missing")
    private_device = Path(capsule_metadata["directory"]) / "root-records/device-approved.json"
    approved_raw = regular(str(private_device)) if private_device.exists() else None
    require((folder / "device-approved.json").exists() == (approved_raw is not None), "unowned device approval cannot become fresh-device authority")
    if approved_raw is not None:
        require(regular(str(folder / "device-approved.json")) == approved_raw, "workload-owned device approval differs from root authority")
    device = json.loads(approved_raw) if approved_raw else None
    if device:
        require(device["runID"] == run and device["simulatorUDID"] not in ready["preexistingSimulatorUDIDs"] and device["independentErase"]["exit"] == 0,
                "actual independent fresh-device/erase provenance missing")
        directory = home / "Library/Developer/CoreSimulator/Devices" / device["simulatorUDID"]
        metadata = plistlib.loads(regular(str(directory / "device.plist")))
        require(metadata.get("UDID", "").upper() == device["simulatorUDID"] and metadata.get("name") == "CalledIt-QA-" + run,
                "actual run-owned simulator disappeared or changed")
    return {"runID": run, "ownerPID": owner_pid, "leasePID": pid, "anchor": ready["anchor"], "checkedAt": int(time.time() * 1000),
            "leaseReadySHA256": digest(ready_raw), "networkProofSHA256": digest(proof_raw),
            "runnerAuthorization": authorization,
            "rootLaunchWitnessSHA256": witness_hash,
            "controller": controller, "controlRuntimeSHA256": ready["controlRuntimeSHA256"],
            "deviceApprovedSHA256": digest(approved_raw) if approved_raw else None, "device": device,
            "sourceFingerprints": source_fingerprints()}


def main():
    parser = argparse.ArgumentParser(description="Read actual live root lease/kernel state for the explicitly trusted adapter verifier")
    parser.add_argument("--directory")
    parser.add_argument("--run-id")
    parser.add_argument("--owner-pid", type=int)
    parser.add_argument("--fingerprint-only", action="store_true")
    args = parser.parse_args()
    result = source_fingerprints() if args.fingerprint_only else live_status(args.directory, args.run_id, args.owner_pid)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
