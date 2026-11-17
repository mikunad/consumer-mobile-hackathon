import argparse
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace


def sha(value):
    return hashlib.sha256(value).hexdigest()


def emit(name, value):
    print(name + " " + json.dumps(value, sort_keys=True), flush=True)


def run(argv, environment, **options):
    return subprocess.run(argv, env=environment, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, **options)


def build_environment(scratch):
    user = pwd.getpwuid(os.getuid())
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", "HOME": user.pw_dir,
            "USER": user.pw_name, "LOGNAME": user.pw_name, "TMPDIR": str(scratch), "LANG": "en_US.UTF-8"}


def build_carrier(root, scratch, environment):
    native = scratch / "native"
    shutil.copytree(root / "native-imessage", native)
    with (scratch / "compile.log").open("w") as log:
        for command in [
            ["xcodegen", "generate"],
            ["xcodebuild", "build", "-project", "CalledItMessages.xcodeproj", "-scheme", "CalledItMessages", "-configuration", "QA", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", "build", "CODE_SIGNING_ALLOWED=NO"],
        ]:
            result = subprocess.run(command, cwd=native, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=900)
            if result.returncode:
                log.flush()
                print("\n".join((scratch / "compile.log").read_text().splitlines()[-100:]), flush=True)
                raise RuntimeError("Unsigned carrier compilation failed before any PF attempt")
    app = native / "build/Build/Products/QA-iphonesimulator/CalledItMessages.app"
    if not app.is_dir():
        raise RuntimeError("Actual unsigned carrier artifact missing")
    destination = root / "out/CalledItMessages.app"
    destination.parent.mkdir()
    shutil.copytree(app, destination)
    return destination


def emit_control_pulse(path, run_id, nonce, sequence):
    value = {"version": 1, "runID": run_id, "launchNonce": nonce, "sequence": sequence, "observedAt": int(time.time() * 1000)}
    emit("CALLED_IT_CONTROL_CHANNEL_PROBE", value)
    temporary = path.with_suffix(".next")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(value, file, sort_keys=True)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--launch-nonce", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    proof = root / "launch-proof"
    manifest_raw = (proof / "source-manifest.json").read_bytes()
    if sha(manifest_raw) != args.source_manifest_sha256:
        raise RuntimeError("Archived source seal differs from the actual tool command")
    manifest = json.loads(manifest_raw)
    config = json.loads((root / "probe-config.json").read_bytes())
    if args.launch_nonce != config["launchNonce"] or manifest["launchNonce"] != args.launch_nonce or manifest["runID"] != config["runID"]:
        raise RuntimeError("Archived run/nonce is not this unique launch")

    def verify_source():
        for name, expected in manifest["files"].items():
            path = root / name
            if path.resolve() != path or sha(path.read_bytes()) != expected:
                raise RuntimeError("Archived input changed: " + name)

    verify_source()
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="calledit-enforcement-")).resolve()
    environment = build_environment(scratch)
    destination = build_carrier(root, scratch, environment)
    verify_source()
    sys.path.insert(0, str(root / "tests/simulator-provisioner"))
    from launch_provenance import verify_trusted_launch
    context = proof / "context.json"
    context_sha = sha(context.read_bytes())
    authorization = verify_trusted_launch(str(context), context_sha, config["runID"])
    emit("CALLED_IT_ENFORCEMENT_PRE_MUTATION", {"authorization": authorization, "scope": "one bounded enforcement-only/restoration probe; no simulator, provider or native runtime"})
    ancestors = []
    current = os.getppid()
    while current > 1 and current not in {record["pid"] for record in ancestors} and len(ancestors) < 12:
        observed = run(["/bin/ps", "-p", str(current), "-o", "ppid=,comm="], environment)
        if observed.returncode or not observed.stdout.strip():
            raise RuntimeError("Actual controller ancestry observation unavailable")
        parent, executable = observed.stdout.strip().split(maxsplit=1)
        ancestors.append({"pid": current, "parentPID": int(parent), "executable": executable})
        current = int(parent)
    if not ancestors:
        raise RuntimeError("Actual controller ancestry unavailable; root must independently prove the approved vsock profile")
    emit("CALLED_IT_CONTROLLER_CANDIDATES", {"runID": config["runID"], "launchNonce": args.launch_nonce, "ancestorsOnly": ancestors,
        "admission": "none; independent root must observe and verify actual connected management vsock and kernel tuples"})
    listing = run(["/usr/bin/xcrun", "simctl", "list", "--json"], environment, check=True)
    listing = json.loads(listing.stdout)
    runtimes = [item for item in listing["runtimes"] if item.get("isAvailable") and ".iOS-" in item["identifier"]]
    runtime = max(runtimes, key=lambda item: tuple(map(int, item["version"].split("."))))
    types = {item["name"]: item["identifier"] for item in listing["devicetypes"]}
    pulse_path = scratch / "control-pulse.json"
    request = {"runID": config["runID"], "nativeSourceRevision": config["nativeSourceRevision"], "backendSourceRevision": config["backendSourceRevision"],
        "fixtureSetID": config["fixtureSetID"], "configVersion": config["configVersion"], "runtimeID": runtime["identifier"],
        "deviceTypeID": types.get("iPhone 17") or types["iPhone 16"], "apiPort": 8199, "cardPort": 3211, "lifetimeSeconds": 180,
        "appPath": str(destination), "nativeBuildRecord": str(scratch / "unused-in-enforcement-only-native-record.json"),
        "backendBuildRecord": str(scratch / "unused-in-enforcement-only-backend-record.json"), "controlPIDs": [record["pid"] for record in ancestors],
        "controlPulsePath": str(pulse_path),
        "sourceCardOrigin": "https://cards.qa-runtime.invalid"}
    request_path = scratch / "request.json"
    request_path.write_text(json.dumps(request))
    request_path.chmod(0o600)
    output = scratch / "probe"
    command = ["/usr/bin/python3", "-E", "-s", str(root / "tests/simulator-provisioner/provision.py"), "--request", str(request_path), "--output", str(output),
        "--trusted-launch-context", str(context), "--trusted-launch-sha256", context_sha, "--enforcement-probe"]
    control_stop = threading.Event()

    emit_control_pulse(pulse_path, config["runID"], args.launch_nonce, 0)

    def controller_traffic():
        sequence = 1
        while not control_stop.wait(2):
            emit_control_pulse(pulse_path, config["runID"], args.launch_nonce, sequence)
            sequence += 1

    traffic = threading.Thread(target=controller_traffic, daemon=True)
    traffic.start()
    try:
        try:
            result = subprocess.run(command, env=environment, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=360)
        except subprocess.TimeoutExpired as failure:
            deadline = time.monotonic() + 110
            while not (output / "lease-cleanup.json").is_file() and time.monotonic() < deadline:
                time.sleep(0.25)
            text = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else value or ""
            result = SimpleNamespace(returncode=124, stdout=text(failure.stdout), stderr=text(failure.stderr) + "\nBounded probe timed out; waited only for independent cleanup, no manual PF override")
    finally:
        control_stop.set()
        traffic.join(timeout=3)
    print(result.stdout, flush=True)
    print(result.stderr, flush=True)
    for path in sorted(output.glob("*.json")):
        emit("CALLED_IT_ENFORCEMENT_RECORD", {"file": path.name, "sha256": sha(path.read_bytes()), "value": json.loads(path.read_bytes())})
    for name in ["lease-stderr.txt", "network-probe-stderr.txt"]:
        path = output / name
        if path.is_file():
            emit("CALLED_IT_ENFORCEMENT_DIAGNOSTIC", {"file": name, "text": path.read_text()[-20000:]})
    completed = output / "completed.json"
    cleanup = output / "lease-cleanup.json"
    passed = result.returncode == 0 and completed.is_file() and cleanup.is_file()
    if passed:
        completion = json.loads(completed.read_bytes())
        restored = json.loads(cleanup.read_bytes())
        passed = completion.get("runID") == config["runID"] and completion.get("status") == "completed-and-owned-isolation-restored" and not restored.get("failures") and restored.get("isolationRetained") is False
    emit("CALLED_IT_ENFORCEMENT_VERDICT", {"runID": config["runID"], "launchNonce": args.launch_nonce, "status": "local-gates-pass-parent-tool-continuity-pending" if passed else "blocked", "probeExitCode": result.returncode,
        "parentToolContinuityVerified": False, "managementChannel": "intentional provider vsock; not proof against arbitrary non-IP/covert channels",
        "testsExecuted": 0, "simulatorCreated": False, "nativeUIExecuted": False, "realProviderExecuted": False, "fullV0Ready": False})
    if not passed:
        raise RuntimeError("Enforcement/restoration probe did not prove its prerequisites; no runtime activation or broader retry")
    evidence = destination / "QAEnforcementProbeEvidence"
    shutil.copytree(output, evidence)
    (evidence / "README.txt").write_text("Unsigned evidence carrier: local enforcement/restoration gates only; independent parent must still validate actual retained tool-log continuity. Intentional provider vsock management channel, not arbitrary non-IP/covert-channel proof. No simulator/native UI/provider/signing/distribution proof. Not an RC.\n")
    verify_source()


if __name__ == "__main__":
    main()
