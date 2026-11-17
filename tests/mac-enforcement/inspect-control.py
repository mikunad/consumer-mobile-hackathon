import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--nonce", required=True)
    args = parser.parse_args()
    nonce = str(uuid.UUID(args.nonce)).upper()
    if nonce != args.nonce or uuid.UUID(nonce).version != 4:
        raise RuntimeError("Unique canonical inspection nonce required")
    root = pathlib.Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("operator_carrier", pathlib.Path(__file__).with_name("enforcement-entry.py"))
    carrier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(carrier)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="calledit-control-inspection-")).resolve()
    environment = carrier.build_environment(scratch)

    def run(argv, check=False):
        return subprocess.run(argv, env=environment, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=check)

    source = pathlib.Path(__file__).with_name("control-sockets.c")
    inspector = scratch / "control-sockets"
    compiled = run(["/usr/bin/xcrun", "--sdk", "macosx", "clang", "-Wall", "-Wextra", "-Werror", "-O2", str(source), "-o", str(inspector), "-lproc"])
    if compiled.returncode:
        print(compiled.stderr, flush=True)
        raise RuntimeError("Read-only socket inspector did not compile against the actual SDK")
    ancestors = []
    current = os.getppid()
    while current > 1 and current not in {item["pid"] for item in ancestors} and len(ancestors) < 12:
        observed = run(["/bin/ps", "-p", str(current), "-o", "ppid=,comm="], check=True)
        parent, executable = observed.stdout.strip().split(maxsplit=1)
        path = pathlib.Path(executable)
        record = {"pid": current, "parentPID": int(parent), "executable": executable}
        if path.is_absolute() and path.is_file():
            record["resolvedExecutable"] = str(path.resolve())
            record["executableSHA256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        ancestors.append(record)
        current = int(parent)
    if not ancestors:
        raise RuntimeError("Actual controller ancestry unavailable")
    inspected = run(["/usr/bin/sudo", "-n", str(inspector), *[str(item["pid"]) for item in ancestors]], check=True)
    sockets = json.loads(inspected.stdout)
    boot = run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], check=True).stdout.strip()
    netstat = run(["/usr/sbin/netstat", "-an", "-f", "vsock"])
    record = {"version": 1, "nonce": nonce, "guestBootSessionUUID": str(uuid.UUID(boot)).upper(), "ancestors": ancestors,
              "inspectorSourceSHA256": hashlib.sha256(source.read_bytes()).hexdigest(), "inspectorBinarySHA256": hashlib.sha256(inspector.read_bytes()).hexdigest(),
              "macOSSDK": run(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"], check=True).stdout.strip(),
              "compiler": run(["/usr/bin/xcrun", "clang", "--version"], check=True).stdout.strip(),
              "kernelSocketObservations": sockets, "vsockNetstat": {"exit": netstat.returncode, "stdout": netstat.stdout, "stderr": netstat.stderr},
              "firewallMutation": False, "simulatorCreated": False, "nativeUIExecuted": False, "testsExecuted": 0,
              "scope": "read-only transport diagnosis; no authority, IP exception, enforcement or readiness conclusion"}
    print("CALLED_IT_CONTROL_TRANSPORT_READONLY " + json.dumps(record, sort_keys=True), flush=True)
    destination = carrier.build_carrier(root, scratch, environment)
    evidence = destination / "QAControlInspectionEvidence"
    evidence.mkdir()
    (evidence / "observations.json").write_text(json.dumps(record, indent=2) + "\n")
    (evidence / "README.txt").write_text("Read-only actual control-transport observations. No PF, simulator, UI, provider, signing or distribution proof. Unsigned carrier only, not an RC.\n")


if __name__ == "__main__":
    main()
