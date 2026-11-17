#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import platform
import plistlib
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from global_pf import controller_flows, plan_rules, require_no_unowned_states, root_anchor_supported
from launch_provenance import verify_trusted_launch

HOST = "com.mikunad.calledit.qa.host"
EXTENSION = HOST + ".messages"
REVISION = re.compile(r"[a-f0-9]{40}")
IDENTIFIER = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class Blocked(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise Blocked(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit=1_048_576):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path and not path.is_symlink(), "absolute non-symlink input required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        stat = os.fstat(fd)
        import stat as stat_module
        require(stat_module.S_ISREG(stat.st_mode) and 0 < stat.st_size <= limit, "invalid bounded artifact")
        with os.fdopen(os.dup(fd), "rb") as file:
            data = file.read(limit + 1)
        require(0 < len(data) <= limit, "artifact exceeded bound")
        return data
    finally:
        os.close(fd)


def write_new(path, value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    require(len(data) <= 1_048_576, "record exceeds receipt artifact bound")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
    finally:
        os.close(fd)
    return digest(data)


def clean_environment(home, temporary):
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
            "HOME": str(home), "TMPDIR": str(temporary) + "/", "LANG": "en_US.UTF-8"}


def load_request(path):
    request = json.loads(regular(path, 32_768))
    fields = {"runID", "nativeSourceRevision", "backendSourceRevision", "fixtureSetID", "configVersion",
              "runtimeID", "deviceTypeID", "apiPort", "cardPort", "lifetimeSeconds", "appPath",
              "nativeBuildRecord", "backendBuildRecord", "controlPIDs", "sourceCardOrigin"}
    require(isinstance(request, dict) and set(request) in (fields, fields | {"controlPulsePath"}), "exact provisioner request fields required")
    if "controlPulsePath" in request:
        require(isinstance(request["controlPulsePath"], str) and Path(request["controlPulsePath"]).is_absolute(), "absolute operator pulse path required")
    request["runID"] = str(uuid.UUID(request["runID"])).upper()
    for key in ("nativeSourceRevision", "backendSourceRevision"):
        require(isinstance(request[key], str) and REVISION.fullmatch(request[key]), "independent source revision required")
    for key in ("fixtureSetID", "configVersion", "runtimeID", "deviceTypeID"):
        require(isinstance(request[key], str) and IDENTIFIER.fullmatch(request[key]), "invalid bounded identifier")
    for key in ("apiPort", "cardPort"):
        require(type(request[key]) is int and 1024 <= request[key] <= 65535, "explicit bounded port required")
    require(type(request["lifetimeSeconds"]) is int and 60 <= request["lifetimeSeconds"] <= 3600, "invalid run lifetime")
    require(isinstance(request["controlPIDs"], list) and request["controlPIDs"] and all(type(pid) is int and pid > 1 for pid in request["controlPIDs"]),
            "actual controller process IDs required, not an assumed separate account")
    require(request["sourceCardOrigin"] == "https://cards.qa-runtime.invalid",
            "the exact approved synthetic HTTPS card source origin is required; no alternate/normalization")
    return request


class Provisioner:
    def __init__(self, request, output, execute=None):
        self.request = request
        self.output = Path(output)
        self.execute = execute or subprocess.run
        self.environment = clean_environment(Path.home(), self.output)
        self.events = []
        self.udid = None
        self.children = []
        self.lease_child = None
        self.heartbeat_stop = threading.Event()
        self.heartbeat_thread = None
        self.sequence = 0
        self.pending_completion = None
        self.trusted_launch_context = None
        self.trusted_launch_sha256 = None
        self.control_profile = None

    def command(self, argv, check=True, timeout=120):
        started = int(time.time() * 1000)
        result = self.execute(argv, env=self.environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, check=False)
        self.events.append({"argv": argv, "exit": result.returncode, "startedAt": started, "at": int(time.time() * 1000),
                            "stdoutSHA256": digest(result.stdout), "stderrSHA256": digest(result.stderr)})
        if check:
            require(result.returncode == 0, "command failed: " + Path(argv[0]).name + " " + " ".join(argv[1:3]))
        return result.stdout.decode("utf-8", errors="strict")

    def simctl(self, *arguments, **kwargs):
        return self.command(["/usr/bin/xcrun", "simctl", *arguments], **kwargs)

    def preflight(self):
        require(platform.system() == "Darwin", "macOS/Xcode simulator host required; Linux results are unit-only")
        require(self.command(["/usr/bin/sudo", "-n", "/usr/bin/id", "-u"]).strip() == "0", "noninteractive administrative PF privilege required")
        root = self.command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-sr"])
        states = self.command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-ss"])
        root_anchor_supported(root)
        flows = []
        if self.control_profile is None:
            sockets = self.command(["/usr/bin/sudo", "-n", "/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(map(str, self.request["controlPIDs"])),
                                    "-iTCP", "-sTCP:ESTABLISHED", "-FpcuftPnT"], timeout=10)
            flows = controller_flows(sockets, self.request["controlPIDs"])
        require_no_unowned_states(states, flows)
        if self.control_profile is None:
            self.anchor, rules = plan_rules(self.request["runID"], flows)
        else:
            from global_pf import plan_no_ip_rules
            self.anchor, rules = plan_no_ip_rules(self.request["runID"])
        require(not self.command(["/usr/bin/sudo", "-n", "/sbin/pfctl", "-a", self.anchor, "-sr"]).strip(), "run anchor already exists")
        self.host_metadata = {"macOS": self.command(["/usr/bin/sw_vers"]), "xcode": self.command(["/usr/bin/xcodebuild", "-version"]),
                              "controllerFlows": flows, "rootRules": root, "preexistingStates": states,
                              "proposedAnchor": self.anchor, "proposedRules": rules,
                              "enforcement": "NOT INSTALLED: read-only preflight, not outbound-denial evidence"}

    def build_records(self):
        result = {}
        for role in ("native", "backend"):
            record_path = self.request[role + "BuildRecord"]
            raw = regular(record_path, 32_768)
            record = json.loads(raw)
            require(set(record) == {"sourceRevision", "artifactPath", "artifactSHA256", "buildID"}, "exact independent build record required")
            require(record["sourceRevision"] == self.request[role + "SourceRevision"] and isinstance(record["buildID"], str) and IDENTIFIER.fullmatch(record["buildID"]), "build record source/build pin mismatch")
            content = regular(record["artifactPath"], 512 * 1024 * 1024)
            require(record["artifactSHA256"] == digest(content), "independent built artifact hash mismatch")
            result[role] = {**record, "recordSHA256": digest(raw)}
        app = Path(self.request["appPath"])
        require(app.is_absolute() and app.resolve() == app and app.is_dir() and app.suffix == ".app", "actual built host app required")
        plugins = list((app / "PlugIns").glob("*.appex"))
        require(len(plugins) == 1, "exactly one actual embedded Messages extension required")
        bundles = []
        for directory, expected in ((app, HOST), (plugins[0], EXTENSION)):
            raw = regular(str(directory / "Info.plist"))
            info = plistlib.loads(raw)
            require(info.get("CFBundleIdentifier") == expected and info.get("CalledItBuildChannel") == "qa" and
                    info.get("CalledItFixtureMode") is False and info.get("CalledItSourceRevision") == self.request["nativeSourceRevision"] and
                    info.get("CalledItAppGroup") == "group.com.mikunad.calledit.qa", "built bundle is not the exact independently pinned QA artifact")
            executable = info.get("CFBundleExecutable")
            require(executable in ("CalledItMessages", "CalledItExtension"), "unexpected actual bundle executable")
            binary = regular(str(directory / executable), 256 * 1024 * 1024)
            bundles.append({"bundleID": expected, "executable": executable, "executableSHA256": digest(binary), "infoSHA256": digest(raw),
                            "buildVersion": info.get("CFBundleVersion"), "marketingVersion": info.get("CFBundleShortVersionString"),
                            "sdkBuild": info.get("DTSDKBuild"), "xcodeBuild": info.get("DTXcodeBuild"),
                            "builtAPIOrigin": info.get("CalledItAPIURL"), "builtCardOrigin": info.get("CalledItWebURL")})
        require(bundles[0]["executableSHA256"] == result["native"]["artifactSHA256"], "native build record must independently hash the actual host executable")
        return {"records": result, "bundles": bundles}

    def create_and_erase(self):
        runtimes = json.loads(self.simctl("list", "runtimes", "--json"))["runtimes"]
        selected = [runtime for runtime in runtimes if runtime.get("identifier") == self.request["runtimeID"] and runtime.get("isAvailable") is True]
        require(len(selected) == 1 and selected[0].get("version") and selected[0].get("buildversion"), "exact available simulator OS/version/build required")
        devices = json.loads(self.simctl("list", "devices", "--json"))["devices"]
        previous = {device["udid"].upper() for group in devices.values() for device in group}
        name = "CalledIt-QA-" + self.request["runID"]
        created = self.simctl("create", name, self.request["deviceTypeID"], self.request["runtimeID"]).strip()
        candidate = str(uuid.UUID(created)).upper()
        require(candidate not in previous, "simctl did not return a newly created run-owned device")
        self.udid = candidate
        self.device_path = Path.home() / "Library/Developer/CoreSimulator/Devices" / self.udid
        require(self.device_path.resolve() == self.device_path, "simulator data path traverses a symlink")
        metadata_bytes = regular(str(self.device_path / "device.plist"))
        metadata = plistlib.loads(metadata_bytes)
        require(metadata.get("UDID", "").upper() == self.udid and metadata.get("name") == name and
                metadata.get("runtime") == self.request["runtimeID"] and metadata.get("deviceType") == self.request["deviceTypeID"], "created simulator metadata mismatch")
        self.created = {"runID": self.request["runID"], "simulatorUDID": self.udid,
                        "device": {key: metadata[key] for key in ("UDID", "name", "runtime", "deviceType")}, "devicePlistSHA256": digest(metadata_bytes),
                        "runtime": selected[0], "host": self.host_metadata, "builds": self.builds, "events": list(self.events)}
        self.simctl("erase", self.udid)
        self.erased = {"runID": self.request["runID"], "simulatorUDID": self.udid, "explicitErase": self.events[-1]}

    def app_inventory(self, label):
        text = self.simctl("listapps", self.udid)
        require(len(text.encode()) <= 1_048_576, "app inventory exceeds bounded record")
        path = self.output / (label + "-apps.plist")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(text)
        parsed = json.loads(self.command(["/usr/bin/plutil", "-convert", "json", "-o", "-", str(path)]))
        require(isinstance(parsed, dict), "actual simulator app inventory is not a property-list dictionary")
        return text, parsed

    def empty_state(self):
        self.boot_started = int(time.time() * 1000)
        require(self.network_proof["verifiedAt"] <= self.boot_started and self.lease_child.poll() is None,
                "actual kernel isolation must be verified and live before any simulator boot")
        self.simctl("boot", self.udid)
        self.simctl("bootstatus", self.udid, "-b", timeout=240)
        apps_text, apps = self.app_inventory("erased")
        require(HOST not in apps and EXTENSION not in apps and all(value.get("ApplicationType") == "System" for value in apps.values()),
                "newly erased simulator has a third-party application or prior Called It install")
        require("com.apple.MobileSMS" in apps, "actual MobileSMS system bundle is absent from this simulator OS; no Messages/extension substitute is permitted")
        root = self.device_path / "data"
        require(root.is_dir() and root.resolve() == root, "run-owned simulator data unavailable")
        messages = []
        for database in root.glob("Library/SMS/*.db"):
            require(database.name == "sms.db" and not database.is_symlink(), "unexpected Messages state database")
            connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
            try:
                tables = {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
                counts = {table: connection.execute('select count(*) from "' + table + '"').fetchone()[0]
                          for table in ("message", "chat", "handle") if table in tables}
                require(set(counts) == {"message", "chat", "handle"} and all(count == 0 for count in counts.values()), "Messages is not demonstrably empty")
                messages.append({"file": str(database.relative_to(root)), "counts": counts})
            finally:
                connection.close()
        contacts = [path for pattern in ("**/AddressBook.sqlitedb", "**/AddressBook-v*.abcddb") for path in root.glob(pattern)]
        contact_counts = []
        for database in contacts:
            require(not database.is_symlink(), "Contacts database is a symlink")
            connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
            try:
                tables = {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
                table = next((name for name in ("ABPerson", "ZABCDRECORD") if name in tables), None)
                require(table is not None, "fresh Contacts schema unknown; no empty-state assumption")
                count = connection.execute('select count(*) from "' + table + '"').fetchone()[0]
                require(count == 0, "new simulator Contacts state is not empty")
                contact_counts.append({"file": str(database.relative_to(root)), "table": table, "count": count})
            finally:
                connection.close()
        require(not list(root.glob("Containers/Shared/AppGroup/*/Library/Preferences/group.com.mikunad.calledit.qa.plist")), "prior QA App Group activation exists")
        self.empty = {"runID": self.request["runID"], "simulatorUDID": self.udid,
                      "systemBundleIDs": sorted(apps), "messages": messages, "contacts": contact_counts,
                      "priorQAAppGroupFiles": 0, "inventorySHA256": digest(apps_text.encode()), "events": self.events[-3:]}
        self.simctl("install", self.udid, self.request["appPath"])
        _, installed = self.app_inventory("installed")
        require(HOST in installed, "host not present in actual post-install inventory")
        container = Path(self.simctl("get_app_container", self.udid, HOST, "app").strip())
        require(container.is_relative_to(self.device_path / "data") and container.resolve() == container, "installed app is not on this run-owned simulator")
        for bundle in self.builds["bundles"]:
            candidates = [container] if bundle["bundleID"] == HOST else list((container / "PlugIns").glob("*.appex"))
            require(len(candidates) == 1 and digest(regular(str(candidates[0] / bundle["executable"]), 256 * 1024 * 1024)) == bundle["executableSHA256"], "actual installed host/extension hash mismatch")
        self.installed = {"bundleID": HOST, "bundle": installed[HOST], "container": str(container), "embeddedExecutableHashesVerified": self.builds["bundles"]}

    def cleanup(self):
        if self.lease_child:
            if self.lease_child.poll() is None:
                write_new(self.output / "lease-stop.json", {"runID": self.request["runID"]})
            self.heartbeat_stop.set()
            if self.heartbeat_thread:
                self.heartbeat_thread.join(timeout=3)
            try:
                self.lease_child.wait(timeout=100)
            except subprocess.TimeoutExpired:
                raise Blocked("independent root lease did not complete cleanup; do not force-disable PF or flush states")
            cleanup = json.loads(regular(str(self.output / "lease-cleanup.json")))
            require(not cleanup["failures"], "independent lease run failed; inspect actual isolationRetained and resource/evidence failure records")
            if self.pending_completion is not None:
                require(self.lease_child.returncode == 0 and cleanup["reason"] == "owner-requested-stop" and not (self.output / "lease-blocked.json").exists(),
                        "independent lease failed despite workload completion; no successful completion may be recorded")
        elif self.udid:
            self.simctl("shutdown", self.udid, check=False)
            self.simctl("delete", self.udid)
        self.heartbeat_stop.set()
        if self.pending_completion is not None:
            write_new(self.output / "completed.json", self.pending_completion)

    def heartbeat(self):
        while not self.heartbeat_stop.is_set():
            temporary = self.output / "heartbeat.next"
            data = json.dumps({"runID": self.request["runID"], "sequence": self.sequence}).encode()
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as file:
                file.write(data)
            os.replace(temporary, self.output / "heartbeat.json")
            self.sequence += 1
            if self.heartbeat_stop.wait(0.5):
                return

    def wait_for_file(self, file, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if file.exists():
                return json.loads(regular(str(file)))
            require(self.lease_child is not None and self.lease_child.poll() is None, "independent PF lease exited before required evidence")
            time.sleep(0.1)
        raise Blocked("required evidence did not arrive: " + file.name)

    def start_lease(self):
        (self.output / "jobs").mkdir(mode=0o700)
        write_new(self.output / "lease-request.json", {"runID": self.request["runID"], "controlPIDs": self.request["controlPIDs"],
                  "controlPulsePath": self.request["controlPulsePath"]})
        self.heartbeat_thread = threading.Thread(target=self.heartbeat, daemon=True)
        self.heartbeat_thread.start()
        deadline = time.monotonic() + 3
        while not (self.output / "heartbeat.json").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        from root_capsule import pinned_bootstrap, source_root
        bootstrap, manifest_sha = pinned_bootstrap(self.trusted_launch_context, self.trusted_launch_sha256)
        error_fd = os.open(self.output / "lease-stderr.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(error_fd, "wb") as errors:
            self.lease_child = subprocess.Popen(["/usr/bin/sudo", "-n", "/usr/bin/python3", "-I", "-S", "-c", bootstrap,
                    str(source_root()), self.trusted_launch_context, self.trusted_launch_sha256, manifest_sha, str(self.output),
                    str(os.getpid()), self.request["runID"], str(self.request["lifetimeSeconds"]), str(os.getuid())], env=self.environment,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, start_new_session=True)
        self.lease_ready = self.wait_for_file(self.output / "lease-ready.json", 120)
        print("GLOBAL_PF_LEASE_ACTIVE " + self.request["runID"], flush=True)

    def start_job(self, argv, label, environment=None):
        require(isinstance(argv, list) and argv, "explicit owner-supplied argv command required")
        command = self.output / (label + "-command.json")
        write_new(command, argv)
        error_file = None
        if label in {"network-probe", "provisioning-ui"}:
            error_file = os.fdopen(os.open(self.output / (label + "-stderr.txt"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb")
        try:
            child = subprocess.Popen(["/usr/bin/python3", "-E", "-s", str(Path(__file__).resolve().parent / "job.py"), str(self.output), str(command)],
                                 env=environment or self.environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=error_file or subprocess.DEVNULL, start_new_session=True)
        finally:
            if error_file:
                error_file.close()
        self.children.append(child)
        self.wait_for_file(self.output / "jobs" / (str(child.pid) + ".approved"), 12)
        return child

    def wait_job(self, child, timeout, label):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            require(self.lease_child.poll() is None, "independent isolation lease stopped while workload was active")
            status = child.poll()
            if status is not None:
                require(status == 0, label + " failed; inspect its run-owned artifacts")
                return
            time.sleep(0.1)
        raise Blocked(label + " exceeded the bounded active lease")

    def publish(self):
        from vsock_control import fingerprint_paths
        require(self.lease_child is not None and self.lease_child.poll() is None and
                self.network_proof["runID"] == self.request["runID"] and self.network_proof["verifiedAt"] <= self.boot_started,
                "live independent isolation and actual pre-boot kernel evidence required before receipt publication")
        now = int(time.time() * 1000)
        expires = min(now + self.request["lifetimeSeconds"] * 1000,
                      self.lease_ready["leaseExpiresAt"] - 15_000)
        require(expires - now >= 30_000, "insufficient active isolation lifetime for native activation")
        manifest = {"version": 1, "runID": self.request["runID"], "simulatorUDID": self.udid,
                    "nativeSourceRevision": self.request["nativeSourceRevision"], "backendSourceRevision": self.request["backendSourceRevision"],
                    "deploymentID": "qa-" + self.request["runID"], "configVersion": self.request["configVersion"],
                    "fixtureSetID": self.request["fixtureSetID"], "apiOrigin": "http://127.0.0.1:" + str(self.request["apiPort"]),
                    "cardOrigin": "http://127.0.0.1:" + str(self.request["cardPort"]), "issuedAt": now, "expiresAt": expires,
                    "erasedSimulator": True, "syntheticDataOnly": True, "outboundNetworkDenied": True}
        manifest_hash = write_new(self.output / "manifest.json", manifest)
        denial = {"runID": self.request["runID"], "simulatorUDID": self.udid, "lease": self.lease_ready,
                  "kernelVerification": self.network_proof, "simulatorBootStartedAt": self.boot_started,
                  "installedBeforeSimulatorBoot": self.network_proof["verifiedAt"] <= self.boot_started,
                  "policyScope": "stateless global IP policy; zero external IP allows; intentional provider vsock management is not arbitrary non-IP/covert-channel coverage",
                  "sourceHashes": {name: digest(path.read_bytes()) for name, path in fingerprint_paths().items()},
                  "leaseReadySHA256": digest(regular(str(self.output / "lease-ready.json"))),
                  "networkProofSHA256": digest(regular(str(self.output / "network-verified.json"))),
                  "sourceCardOrigin": self.request["sourceCardOrigin"], "sourceBuilds": self.builds}
        artifacts = []
        for kind, content in (("simulator-created", self.created), ("simulator-erased", self.erased),
                              ("empty-state-verified", self.empty), ("outbound-denied", denial)):
            name = kind + ".json"
            artifacts.append({"kind": kind, "file": name, "sha256": write_new(self.output / name, content)})
        write_new(self.output / "receipt.json", {"version": 1, "runID": self.request["runID"], "simulatorUDID": self.udid,
                    "nativeSourceRevision": self.request["nativeSourceRevision"], "backendSourceRevision": self.request["backendSourceRevision"],
                    "fixtureSetID": self.request["fixtureSetID"], "hostBundleID": HOST, "extensionBundleID": EXTENSION,
                    "manifestSHA256": manifest_hash, "recordedAt": int(time.time() * 1000), "artifacts": artifacts})
        write_new(self.output / "context.json", {"version": 1, "phase": "isolated-runtime", "request": self.request, "simulatorUDID": self.udid,
                  "ownerPID": os.getpid(),
                  "harnessDirectory": str(Path(__file__).resolve().parent),
                  "trustedLaunchContext": self.trusted_launch_context, "trustedLaunchSHA256": self.trusted_launch_sha256,
                  "manifestPath": str(self.output / "manifest.json"), "receiptPath": str(self.output / "receipt.json"),
                  "manifestSHA256": manifest_hash, "emptyStateSHA256": artifacts[2]["sha256"], "leaseExpiresAt": expires})
        return expires

    def run(self, enforcement_probe=False, backend_command=None, runtime_command=None, xctestrun=None, fixture_phone=None,
            trusted_launch_context=None, trusted_launch_sha256=None):
        require(not self.output.exists() and self.output.is_absolute() and self.output.parent.resolve() == self.output.parent,
                "fresh absolute non-symlink output directory required")
        self.output.mkdir(mode=0o700)
        try:
            require(trusted_launch_context and trusted_launch_sha256, "trusted parent mobile.build launch provenance required; generic/local/paired mutation refused")
            self.trusted_launch_context = trusted_launch_context
            self.trusted_launch_sha256 = trusted_launch_sha256
            launch = verify_trusted_launch(trusted_launch_context, trusted_launch_sha256, self.request["runID"])
            write_new(self.output / "runner-launch-chain.json", launch)
            from vsock_control import load_profile
            self.control_profile, _ = load_profile()
            require(self.request.get("controlPulsePath"), "actual operator stdout liveness pulse is required for the vsock-only profile")
            self.preflight()
            if not enforcement_probe:
                self.builds = self.build_records()
                require(backend_command and runtime_command and xctestrun and fixture_phone and re.fullmatch(r"\+120255501\d{2}", fixture_phone),
                        "actual parent backend/runtime argv, built xctestrun and reserved fixture phone required")
            self.start_lease()
            probe = self.start_job(["/usr/bin/python3", "-E", "-s", str(Path(__file__).resolve().parent / "netprobe.py"),
                                    "--directory", str(self.output), "--run-id", self.request["runID"]], "network-probe")
            self.wait_job(probe, 60, "actual kernel/controller/resolver verification")
            self.network_proof = json.loads(regular(str(self.output / "network-verified.json")))
            require(self.network_proof["runID"] == self.request["runID"], "kernel verification run mismatch")
            if enforcement_probe:
                self.pending_completion = {"runID": self.request["runID"], "status": "completed-and-owned-isolation-restored",
                                           "localVerdict": "local-gates-pass-parent-tool-continuity-pending", "parentToolContinuityVerified": False,
                                           "scope": "kernel/controller/broker only; no simulator/native behavior proof"}
                return
            self.create_and_erase()
            write_new(self.output / "device.json", {"runID": self.request["runID"], "simulatorUDID": self.udid})
            approved_device = self.wait_for_file(self.output / "device-approved.json", 40)
            self.erased["independentLeaseErase"] = approved_device
            self.empty_state()
            expires = self.publish()
            child_environment = {**self.environment, "CALLED_IT_PROVISIONER_CONTEXT": str(self.output / "context.json")}
            backend = self.start_job(backend_command, "owner-backend", child_environment)
            import socket
            deadline = time.monotonic() + 90
            pending = {3210, self.request["apiPort"], self.request["cardPort"]}
            while pending and time.monotonic() < deadline:
                require(backend.poll() is None, "parent-owned backend binding exited before readiness")
                for port in list(pending):
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            pending.remove(port)
                    except OSError:
                        pass
                time.sleep(0.1)
            require(not pending, "parent-owned official backend/gateway/site did not bind their exact loopback ports")
            driver = self.start_job(["/usr/bin/python3", "-E", "-s", str(Path(__file__).resolve().parent / "drive.py"),
                                    "--context", str(self.output / "context.json"), "--xctestrun", xctestrun, "--fixture-phone", fixture_phone], "provisioning-ui", child_environment)
            self.wait_job(driver, max(1, (expires - int(time.time() * 1000)) / 1000), "actual fresh Messages/extension driver")
            runtime = self.start_job(runtime_command, "owner-runtime", child_environment)
            self.wait_job(runtime, max(1, (expires - int(time.time() * 1000)) / 1000), "parent-owned native scenario lane")
            require(backend.poll() is None, "official backend process group exited during native runtime")
            jobs = self.simctl("spawn", self.udid, "launchctl", "list")
            processes = self.command(["/bin/ps", "-axo", "uid=,pid=,ppid=,comm="])
            write_new(self.output / "runtime-observations.json", {"runID": self.request["runID"], "simulatorUDID": self.udid,
                      "runtimeProcessGroupPID": backend.pid, "simulatorJobs": jobs, "processes": processes,
                      "classification": "synthetic-loopback native provisioning/UI; parent owns business assertions/provider/overlay provenance"})
            self.pending_completion = {"runID": self.request["runID"], "status": "completed-and-owned-isolation-restored",
                      "scope": "native provisioning and parent-owned runtime; not an independent full-V0 verdict",
                      "manifestSHA256": digest(regular(str(self.output / "manifest.json"))), "events": self.events}
        except BaseException as error:
            write_new(self.output / "blocked.json", {"runID": self.request["runID"], "status": "blocked",
                      "reason": str(error) if isinstance(error, RuntimeError) else type(error).__name__, "events": self.events})
            raise
        finally:
            self.cleanup()

    def inspect(self):
        require(not self.output.exists() and self.output.is_absolute() and self.output.parent.resolve() == self.output.parent,
                "fresh absolute non-symlink output directory required")
        self.output.mkdir(mode=0o700)
        try:
            self.preflight()
            self.builds = self.build_records()
            write_new(self.output / "preflight.json", {"runID": self.request["runID"], "status": "preflight-only",
                      "request": self.request, "host": self.host_metadata, "builds": self.builds, "events": self.events})
        except Exception as error:
            write_new(self.output / "blocked.json", {"runID": self.request["runID"], "status": "blocked",
                      "reason": str(error) if isinstance(error, (Blocked, RuntimeError)) else type(error).__name__, "events": self.events})
            raise


def main():
    parser = argparse.ArgumentParser(description="Run-owned fresh cloud Mac simulator lane with independent stateless global-PF lease")
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--enforcement-probe", action="store_true")
    parser.add_argument("--backend-command")
    parser.add_argument("--runtime-command")
    parser.add_argument("--xctestrun")
    parser.add_argument("--fixture-phone")
    parser.add_argument("--trusted-launch-context")
    parser.add_argument("--trusted-launch-sha256")
    args = parser.parse_args()
    provisioner = Provisioner(load_request(args.request), args.output)
    def interrupted(_signum, _frame):
        raise Blocked("provisioner interrupted; independent lease owns stop-before-firewall cleanup")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    if args.inspect_only:
        provisioner.inspect()
        return
    def command_file(path):
        if not path:
            return None
        value = json.loads(regular(path, 32_768))
        require(isinstance(value, list) and value and all(isinstance(item, str) and item for item in value), "owner command must be an argv JSON array")
        return value
    provisioner.run(args.enforcement_probe, command_file(args.backend_command), command_file(args.runtime_command), args.xctestrun, args.fixture_phone,
                    args.trusted_launch_context, args.trusted_launch_sha256)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Simulator provisioner BLOCKED: " + (str(error) if isinstance(error, (Blocked, RuntimeError)) else type(error).__name__), file=sys.stderr)
        sys.exit(2)
