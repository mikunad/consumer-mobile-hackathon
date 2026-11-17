import json
import os
import stat
import re
import subprocess
import time
from pathlib import Path

from provision import digest, regular, require


PROFILE_NAME = "vsock-profile.json"
SOURCE_NAME = "tests/mac-enforcement/control-sockets.c"
SOURCE_SHA256 = "c0ddc25f00b9d99675d52fed1618e938ee28a8ed34715c7846f36eb44e379a99"
AGENT_SHA256 = "5dcc2c8043f79604896d60f91dffe6e98bf39d75ad1555b8dbbb8b6ba8bfe043"
HELPERS = Path("/private/var/run/calledit-qa-helpers")


def fingerprint_paths():
    folder = Path(__file__).resolve().parent
    return {**{path.name: path for pattern in ("*.py", "*.ts") for path in sorted(folder.glob(pattern))},
            PROFILE_NAME: folder / PROFILE_NAME, "control-sockets.c": folder.parents[1] / SOURCE_NAME}


def load_profile():
    raw = regular(str(Path(__file__).resolve().parent / PROFILE_NAME), 16_384)
    value = json.loads(raw)
    require(set(value) == {"version", "profileID", "inspectorSource", "inspectorSourceSHA256", "agentPath", "agentSHA256", "sdkConstants",
                           "localPort", "hostCID", "compiler", "externalIPAllows", "classification"} and
            type(value["version"]) is int and value["version"] == 1 and value["profileID"] == "revyl-tart-vsock8080-no-ip-v1" and value["inspectorSource"] == SOURCE_NAME and
            value["inspectorSourceSHA256"] == SOURCE_SHA256 and value["agentSHA256"] == AGENT_SHA256 and
            value["agentPath"] == "/opt/homebrew/Cellar/tart-guest-agent/0.14.1/bin/tart-guest-agent" and
            value["sdkConstants"] == {"afVsockFromSDK": 40, "sockInfoVsockFromSDK": 7, "streamTypeFromSDK": 1} and
            value["localPort"] == 8080 and value["hostCID"] == 2 and type(value["externalIPAllows"]) is int and value["externalIPAllows"] == 0 and
            value["compiler"] == {"driver": "/usr/bin/xcrun", "sdk": "macosx", "sdkVersion": "27.0", "flags": ["-Wall", "-Wextra", "-Werror", "-O2", "-lproc"]},
            "only the reviewed fixed no-IP-exception vsock profile is authorized")
    return value, digest(raw)


def netstat_connections(text):
    require(len(text) <= 1_048_576, "truncated/oversized vsock kernel table")
    lines = [line.split() for line in text.splitlines() if line.strip()]
    require(len(lines) >= 2 and lines[0] == ["Active", "VSock", "sockets"] and
            lines[1] == ["Proto", "Type", "Recv-Q", "Send-Q", "Local", "Address", "Foreign", "Address", "State"], "unreviewed vsock kernel table format")
    connections = set()
    for row in lines[2:]:
        require(len(row) == 7 and row[:2] == ["vsock", "stream"] and row[2].isdecimal() and row[3].isdecimal(), "unrecognized vsock kernel row")
        if row[6] == "LISTEN":
            require(row[4] == "*:8080" and row[5] == "*:*", "unreviewed vsock listener")
            continue
        require(row[6] == "ESTABLISHED", "unstable or unknown vsock connection state")
        endpoints = row[4].split(":") + row[5].split(":")
        require(len(endpoints) == 4 and all(item.isdecimal() and 0 < int(item) < 4294967295 for item in endpoints), "invalid vsock kernel tuple")
        connection = tuple(map(int, endpoints))
        require(connection not in connections, "duplicate vsock kernel tuple")
        connections.add(connection)
    return connections


def typed_observation(payload, ancestry, agent_pid, table, profile):
    require(isinstance(payload, dict) and set(payload) == {*profile["sdkConstants"], "processes"} and
            all(type(payload[key]) is int and payload[key] == value for key, value in profile["sdkConstants"].items()), "actual SDK-typed vsock observation required")
    records = payload["processes"]
    require(isinstance(records, list) and len(records) == len(ancestry), "incomplete helper process snapshot")
    expected = {record["pid"]: record for record in ancestry}
    identities = []
    connections = []
    seen = set()
    for record in records:
        require(set(record) == {"pid", "parentPID", "uid", "birthSeconds", "birthMicroseconds", "sockets", "identityStable"} and
                type(record["pid"]) is int and record["pid"] in expected and record["pid"] not in seen and record["identityStable"] is True and
                record["parentPID"] == expected[record["pid"]]["parentPID"] and type(record["uid"]) is int and record["uid"] >= 0 and
                type(record["birthSeconds"]) is int and record["birthSeconds"] > 0 and type(record["birthMicroseconds"]) is int and
                0 <= record["birthMicroseconds"] < 1_000_000 and isinstance(record["sockets"], list), "failed/unstable ancestor identity observation")
        seen.add(record["pid"])
        identities.append({key: record[key] for key in ("pid", "parentPID", "uid", "birthSeconds", "birthMicroseconds")})
        fds = set()
        for socket in record["sockets"]:
            require(type(socket.get("fd")) is int and socket["fd"] >= 0 and socket["fd"] not in fds and
                    all(type(socket.get(key)) is int for key in ("family", "type", "protocol", "kind", "state")) and
                    type(socket.get("connected")) is bool, "failed/truncated per-FD socket observation")
            fds.add(socket["fd"])
            if record["pid"] != agent_pid or not socket["connected"]:
                continue
            require(socket["family"] == profile["sdkConstants"]["afVsockFromSDK"] and socket["kind"] == profile["sdkConstants"]["sockInfoVsockFromSDK"] and
                    socket["type"] == profile["sdkConstants"]["streamTypeFromSDK"] and socket["protocol"] == 0 and
                    socket["state"] & 2 != 0 and
                    all(type(socket.get(key)) is int for key in ("localCID", "localPort", "remoteCID", "remotePort")) and
                    2 < socket["localCID"] < 4294967295 and socket["localPort"] == profile["localPort"] and socket["remoteCID"] == profile["hostCID"] and
                    0 < socket["remotePort"] < 4294967295, "agent control must be actual connected typed host vsock8080, never TCP/name/listener-only")
            connection = tuple(socket[key] for key in ("localCID", "localPort", "remoteCID", "remotePort"))
            require(connection in table, "per-FD vsock tuple missing from actual live kernel table")
            connections.append({key: socket[key] for key in ("fd", "localCID", "localPort", "remoteCID", "remotePort")})
    require(0 < len(connections) <= 256 and len({tuple(item.values())[1:] for item in connections}) == len(connections), "missing/duplicate connected agent streams")
    return {"identities": sorted(identities, key=lambda item: item["pid"]), "connections": sorted(connections, key=lambda item: item["fd"])}


def read_pulse(path, authorization, owner_uid):
    path = Path(path)
    require(path.parent.resolve() == path.parent and path.parent.stat().st_uid == owner_uid and path.parent.stat().st_mode & 0o077 == 0,
            "operator pulse must be in the private owner directory")
    pulse = json.loads(regular(str(path), 4096))
    require(path.stat().st_uid == owner_uid and path.stat().st_mode & 0o077 == 0 and
            set(pulse) == {"version", "runID", "launchNonce", "sequence", "observedAt"} and type(pulse["version"]) is int and pulse["version"] == 1 and
            pulse["runID"] == authorization["runID"] and pulse["launchNonce"] == authorization["launchNonce"] and
            type(pulse["sequence"]) is int and pulse["sequence"] >= 0 and type(pulse["observedAt"]) is int and
            -1000 <= int(time.time() * 1000) - pulse["observedAt"] < 8000, "fresh current nonce-tagged operator pulse required; local liveness only")
    return pulse


def ancestry(owner_pid, command):
    records = []
    current = owner_pid
    while current > 1:
        require(len(records) < 12 and current not in {record["pid"] for record in records}, "unstable/oversized actual owner ancestry")
        values = command(["/bin/ps", "-p", str(current), "-o", "ppid=,comm="]).strip().split(maxsplit=1)
        require(len(values) == 2 and values[0].isdecimal(), "actual ancestor observation unavailable")
        path = Path(values[1])
        require(path.is_absolute() or values[1] == "sudo", "unreviewed relative ancestor executable label")
        parent = int(values[0])
        records.append({"pid": current, "parentPID": parent, "executable": str(path.resolve()) if path.is_absolute() else "sudo"})
        current = parent
    require(records and records[-1]["parentPID"] == 1, "actual ancestry must terminate at launchd")
    return records


def observe(owner_pid, requested_pids, helper, profile, command):
    ancestors = ancestry(owner_pid, command)
    require(isinstance(requested_pids, list) and requested_pids and len(set(requested_pids)) == len(requested_pids) and
            all(type(pid) is int and pid in {item["pid"] for item in ancestors} for pid in requested_pids), "supplied control PIDs are not actual owner ancestors")
    agents = [item for item in ancestors if item["executable"] == profile["agentPath"]]
    require(len(agents) == 1 and agents[0]["pid"] in requested_pids, "exact independently derived ancestor agent required")
    require(digest(regular(profile["agentPath"], 64 * 1024 * 1024)) == profile["agentSHA256"], "installed resolved agent executable changed")
    argv = [helper, *[str(item["pid"]) for item in ancestors]]
    before = command(argv)
    table_raw = command(["/usr/sbin/netstat", "-an", "-f", "vsock"])
    after = command(argv)
    require(len(before) <= 1_048_576 and len(after) <= 1_048_576, "oversized socket snapshots")
    table = netstat_connections(table_raw)
    first = typed_observation(json.loads(before), ancestors, agents[0]["pid"], table, profile)
    second = typed_observation(json.loads(after), ancestors, agents[0]["pid"], table, profile)
    require(first == second and ancestors == ancestry(owner_pid, command) and
            digest(regular(profile["agentPath"], 64 * 1024 * 1024)) == profile["agentSHA256"], "control identities/endpoints changed across independent observations")
    return {**first, "ancestors": ancestors, "agentPID": agents[0]["pid"], "agentSHA256": profile["agentSHA256"],
            "netstatSHA256": digest(table_raw.encode()), "classification": profile["classification"]}


def stable_control(observation):
    return {key: value for key, value in observation.items() if key != "netstatSHA256"}


def trusted_path(path, directory=False, namespace_cache=None):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path and (path.is_dir() if directory else path.is_file()),
            "absolute resolved trusted compiler/SDK path required: " + str(path))
    for item in (path, *path.parents):
        info = item.stat()
        detail = str(item) + " uid=" + str(info.st_uid) + " mode=" + oct(stat.S_IMODE(info.st_mode))
        require(info.st_uid == 0 and info.st_mode & 0o022 == 0, "compiler/SDK path has a nonroot-writable component: " + detail)
        if namespace_cache is not None and stat.S_ISDIR(info.st_mode) and item in namespace_cache:
            continue
        try:
            acl = subprocess.run(["/bin/ls", "-lde", str(item)], env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/var/root", "LANG": "C", "LC_ALL": "C"},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
        except Exception as error:
            raise RuntimeError("compiler/SDK ACL observation failed: " + detail + " error=" + type(error).__name__) from error
        entries = acl.stdout.decode(errors="replace").splitlines()[1:]
        require(acl.returncode == 0 and len(acl.stdout) <= 16_384 and all(" deny " in line and " allow " not in line and line.lstrip()[:1].isdigit() for line in entries),
                "compiler/SDK ACL is unavailable or grants/contains unreviewed access: " + detail + " acl=" + repr(entries)[:2048])
        if namespace_cache is not None and stat.S_ISDIR(info.st_mode):
            namespace_cache.add(item)
    return path


def dependency_paths(text):
    require(0 < len(text) <= 1_048_576 and text.count(":") == 1 and text.startswith("calledit-helper:"), "unknown/incomplete compiler dependency format")
    body = text.split(":", 1)[1].replace("\\\n", " ").strip()
    require("\n" not in body and "\r" not in body and "\\" not in body, "unknown compiler dependency continuation/escaping")
    paths = body.split()
    require(0 < len(paths) <= 2048 and len(set(paths)) == len(paths) and
            all(re.fullmatch(r"/[A-Za-z0-9_./+\-]+", path) and ".." not in Path(path).parts for path in paths),
            "unreviewed escaped/relative/truncated compiler dependencies")
    return paths


def dependency_seal(text, source, sdk, resources):
    paths = dependency_paths(text)
    source = Path(source)
    require(str(source) in paths, "full -M dependency closure must include the sealed C source")
    namespace_cache = set()
    fingerprints = {}
    for name in paths:
        path = Path(name).resolve()
        require(path == source or path.is_relative_to(sdk) or path.is_relative_to(resources), "compiler include dependency outside the reviewed SDK/resource/source roots")
        for parent in Path(name).parents:
            trusted_path(parent.resolve(), directory=True, namespace_cache=namespace_cache)
        trusted_path(path, namespace_cache=namespace_cache)
        fingerprints[str(path)] = digest(regular(str(path), 64 * 1024 * 1024))
    return fingerprints


def root_write(path, content, mode=0o400):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(content)
        file.flush()
        os.fchmod(file.fileno(), mode)
        os.fsync(file.fileno())


class RootControl:
    def __init__(self, owner_pid, requested_pids, pulse_path, owner_uid, authorization, root_witness_sha256, request_sha256, output_directory):
        require(os.geteuid() == 0, "privileged control compilation is root-only")
        self.authorization = authorization
        self.owner_uid = owner_uid
        self.pulse_path = pulse_path
        self.profile, profile_sha = load_profile()
        self.owner_pid = owner_pid
        self.requested_pids = requested_pids
        self.last_pulse = read_pulse(pulse_path, authorization, owner_uid)
        self.progress_at = time.monotonic()
        try:
            HELPERS.mkdir(mode=0o755)
            os.chmod(HELPERS, 0o755)
        except FileExistsError:
            pass
        trusted_path(HELPERS, directory=True)
        self.directory = HELPERS / authorization["launchNonce"]
        self.directory.mkdir(mode=0o700)
        self.helper = self.directory / "control-sockets"
        self.environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/var/root", "TMPDIR": str(self.directory), "LANG": "C", "LC_ALL": "C"}
        source = Path(__file__).resolve().parents[2] / SOURCE_NAME
        raw = regular(str(source))
        require(digest(raw) == SOURCE_SHA256, "reviewed C inspector source changed")
        copy = self.directory / "control-sockets.c"
        root_write(copy, raw)
        driver = trusted_path(Path("/usr/bin/xcrun"))
        compiler = trusted_path(Path(self.command([str(driver), "--sdk", "macosx", "--find", "clang"]).strip()).resolve())
        sdk = trusted_path(Path(self.command([str(driver), "--sdk", "macosx", "--show-sdk-path"]).strip()).resolve(), directory=True)
        sdk_version = self.command([str(driver), "--sdk", "macosx", "--show-sdk-version"]).strip()
        require(sdk_version == self.profile["compiler"]["sdkVersion"], "actual SDK is outside the reviewed profile")
        sdk_settings = {name: digest(regular(str(trusted_path(sdk / name)), 5_242_880))
                        for name in ("SDKSettings.json", "SDKSettings.plist") if (sdk / name).exists()}
        require(sdk_settings, "actual trusted SDK configuration missing")
        resources = trusted_path(Path(self.command([str(compiler), "-print-resource-dir"]).strip()).resolve(), directory=True)
        compiler_sha = digest(regular(str(compiler), 512 * 1024 * 1024))
        linker = trusted_path((compiler.parent / "ld").resolve())
        linker_sha = digest(regular(str(linker), 512 * 1024 * 1024))
        trusted_path(sdk / "usr/lib", directory=True)
        link_inputs = {}
        for name in ("libproc.tbd", "libSystem.tbd"):
            stub = (sdk / "usr/lib" / name).resolve()
            require(stub.is_relative_to(sdk), "link stub resolved outside the reviewed SDK")
            trusted_path(stub)
            link_inputs[str(stub)] = digest(regular(str(stub), 16_777_216))
        common = [str(compiler), "-isysroot", str(sdk), "-Wall", "-Wextra", "-Werror", "-O2"]
        dependency_argv = [*common, "-M", "-MT", "calledit-helper", str(copy)]
        dependencies_raw = self.command(dependency_argv, timeout=60)
        dependencies = dependency_seal(dependencies_raw, copy, sdk, resources)
        dependency_file = self.directory / "compile-dependencies.mk"
        compiler_argv = [*common, "-MD", "-MF", str(dependency_file), "-MT", "calledit-helper", str(copy), "-o", str(self.helper), "-lproc"]
        self.command(compiler_argv, timeout=60)
        actual_dependencies_raw = regular(str(dependency_file)).decode()
        require(dependency_seal(actual_dependencies_raw, copy, sdk, resources) == dependencies and
                dependency_seal(dependencies_raw, copy, sdk, resources) == dependencies and
                digest(regular(str(compiler), 512 * 1024 * 1024)) == compiler_sha and
                digest(regular(str(linker), 512 * 1024 * 1024)) == linker_sha and
                all(digest(regular(str(trusted_path(Path(name))), 16_777_216)) == pin for name, pin in link_inputs.items()),
                "compiler/header/linker closure changed across compilation; generated helper must never execute")
        require(self.helper.stat().st_uid == 0 and stat.S_ISREG(self.helper.stat().st_mode) and not self.helper.is_symlink(), "compiler output is not owned regular helper")
        os.chmod(self.helper, 0o500)
        self.baseline = self.observation()
        self.runtime = {"version": 1, "profileID": self.profile["profileID"], "profileSHA256": profile_sha, "sourceSHA256": SOURCE_SHA256,
                        "helperPath": str(self.helper), "helperSHA256": digest(regular(str(self.helper), 64 * 1024 * 1024)),
                        "compilerPath": str(compiler), "compilerSHA256": compiler_sha, "linkerPath": str(linker), "linkerSHA256": linker_sha,
                        "linkInputsSHA256": link_inputs, "includeDependenciesSHA256": dependencies,
                        "dependencyScanSHA256": digest(dependencies_raw.encode()), "compileDependenciesSHA256": digest(actual_dependencies_raw.encode()),
                        "dependencyScanArgv": dependency_argv, "compilerResourcePath": str(resources),
                        "sdkPath": str(sdk), "sdkVersion": sdk_version, "compilerArgv": compiler_argv,
                        "sdkSettingsSHA256": sdk_settings, "compilerVersion": self.command([str(compiler), "--version"]),
                        "compilerEnvironment": self.environment, "rootLaunchWitnessSHA256": root_witness_sha256,
                        "launchChainSHA256": authorization["chainSHA256"], "runID": authorization["runID"], "launchNonce": authorization["launchNonce"],
                        "guestBootSessionUUID": authorization["guestBootSessionUUID"], "rootGuardPID": os.getpid(),
                        "ownerPID": owner_pid, "ownerUID": owner_uid, "requestedPIDs": requested_pids,
                        "controlPulsePath": pulse_path, "baseline": self.baseline, "recordedAt": int(time.time() * 1000)}
        self.runtime["leaseRequestSHA256"] = request_sha256
        directory_info = Path(output_directory).stat()
        require(Path(output_directory).resolve() == Path(output_directory) and stat.S_ISDIR(directory_info.st_mode) and
                directory_info.st_uid == owner_uid and directory_info.st_mode & 0o077 == 0, "actual run output must remain a private owner directory")
        self.runtime["outputDirectory"] = output_directory
        self.runtime["outputDirectoryIdentity"] = {"device": directory_info.st_dev, "inode": directory_info.st_ino, "uid": directory_info.st_uid}
        metadata = json.dumps(self.runtime, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        self.runtime_sha256 = digest(metadata)
        root_write(self.directory / "control-witness.json", metadata)
        os.chmod(self.directory, 0o500)

    def command(self, argv, timeout=10):
        deadline = getattr(self, "observation_deadline", None)
        if deadline is not None:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "bounded control observation deadline expired")
            timeout = min(timeout, remaining)
        result = subprocess.run(argv, env=self.environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        require(result.returncode == 0 and len(result.stdout) <= 1_048_576,
                "root control compiler/observer failed: " + " ".join(argv[:4]) + " exit=" + str(result.returncode) + " stderrSHA256=" + digest(result.stderr))
        return result.stdout.decode()

    def observation(self):
        self.observation_deadline = time.monotonic() + 6
        try:
            return observe(self.owner_pid, self.requested_pids, str(self.helper), self.profile, self.command)
        finally:
            self.observation_deadline = None

    def check(self):
        require(self.helper.stat().st_uid == 0 and self.helper.stat().st_mode & 0o222 == 0 and
                digest(regular(str(self.helper), 64 * 1024 * 1024)) == self.runtime["helperSHA256"], "root helper identity changed")
        current = self.observation()
        require(stable_control(current) == stable_control(self.baseline), "actual controller ancestry/birth/FD endpoint continuity changed")
        pulse = read_pulse(self.pulse_path, self.authorization, self.owner_uid)
        require(pulse["sequence"] >= self.last_pulse["sequence"] and pulse["observedAt"] >= self.last_pulse["observedAt"], "operator pulse decreased")
        if pulse["sequence"] > self.last_pulse["sequence"]:
            self.progress_at = time.monotonic()
        require(time.monotonic() - self.progress_at < 8, "operator stdout pulse did not progress; external delivery remains separately unproven")
        self.last_pulse = pulse
        return {"observation": current, "localLivenessPulse": pulse, "externalDelivery": "requires independent parent tool-log window verification"}


def live_control(ready, authorization, root_witness_sha256, command):
    runtime = ready["controlRuntime"]
    helper = HELPERS / authorization["launchNonce"] / "control-sockets"
    require(runtime["helperPath"] == str(helper) and runtime["launchChainSHA256"] == authorization["chainSHA256"] and
            runtime["rootLaunchWitnessSHA256"] == root_witness_sha256 and runtime["rootGuardPID"] == ready["leasePID"] and
            runtime["ownerPID"] == ready["ownerPID"] and runtime["guestBootSessionUUID"] == authorization["guestBootSessionUUID"], "root-compiled control witness is not from this guard/nonce/current boot")
    for path, directory in ((HELPERS, True), (helper.parent, True), (helper, False), (helper.parent / "control-witness.json", False)):
        info = command(["/usr/bin/sudo", "-n", "/usr/bin/stat", "-f", "%u:%Lp:%HT", str(path)]).strip().split(":")
        require(len(info) == 3 and info[0] == "0" and int(info[1], 8) & (0o022 if directory else 0o222) == 0 and
                info[2] == ("Directory" if directory else "Regular File"), "privileged helper path is not protected root-owned state")
    raw = command(["/usr/bin/sudo", "-n", "/bin/cat", str(helper.parent / "control-witness.json")]).encode()
    require(digest(raw) == ready["controlRuntimeSHA256"] and json.loads(raw) == runtime, "immutable root control witness changed")
    require(command(["/usr/bin/sudo", "-n", "/usr/bin/shasum", "-a", "256", str(helper)]).split()[0] == runtime["helperSHA256"], "privileged helper binary changed")
    profile, profile_sha = load_profile()
    require(profile_sha == runtime["profileSHA256"] and runtime["sourceSHA256"] == SOURCE_SHA256, "control profile/source seal changed")
    def privileged(argv):
        return command(["/usr/bin/sudo", "-n", *argv])
    current = observe(runtime["ownerPID"], runtime["requestedPIDs"], str(helper), profile, privileged)
    require(stable_control(current) == stable_control(runtime["baseline"]), "live controller no longer matches the root-owned baseline")
    pulse = read_pulse(runtime["controlPulsePath"], authorization, runtime["ownerUID"])
    output = Path(runtime["outputDirectory"])
    output_info = output.stat()
    require(output.resolve() == output and {"device": output_info.st_dev, "inode": output_info.st_ino, "uid": output_info.st_uid} == runtime["outputDirectoryIdentity"] and
            output_info.st_uid == runtime["ownerUID"] and output_info.st_mode & 0o077 == 0, "immutable run directory identity changed")
    return {"observation": current, "localLivenessPulse": pulse, "ownerUID": runtime["ownerUID"], "outputDirectory": runtime["outputDirectory"],
            "rootControlWitnessSHA256": ready["controlRuntimeSHA256"],
            "externalDelivery": "not inferred; parent must validate actual nonce-tagged tool logs over enforcement window"}
