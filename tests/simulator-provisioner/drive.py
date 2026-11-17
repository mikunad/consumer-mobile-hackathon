#!/usr/bin/env python3
import argparse
import base64
import json
import os
import plistlib
import re
import subprocess
import sys
import uuid
from pathlib import Path

from provision import Blocked, clean_environment, digest, regular, require, write_new


METHOD = "CalledItUITests/ProvisioningDriveTests/testOpenOnlyFreshSyntheticComposeAndActualEmbeddedExtension"


def prepare_test_run(raw, original_folder, run_id, simulator_udid, manifest_raw, fixture_phone):
    payload = plistlib.loads(raw)
    run = str(uuid.UUID(run_id)).upper()
    simulator = str(uuid.UUID(simulator_udid)).upper()
    targets = []
    if "TestConfigurations" in payload:
        for configuration in payload["TestConfigurations"]:
            targets.extend(configuration.get("TestTargets", []))
    else:
        targets = [value for key, value in payload.items() if not key.startswith("__") and isinstance(value, dict)]
    selected = [target for target in targets if target.get("BlueprintName") == "CalledItUITests" and target.get("IsUITestBundle") is True]
    require(len(selected) == 1, "exact actual CalledItUITests target missing from supplied built xctestrun")
    target = selected[0]
    inherited = target.get("EnvironmentVariables", {})
    require(isinstance(inherited, dict) and not any(any(fragment in key.upper() for fragment in ("TOKEN", "SECRET", "PASSCODE", "TWILIO", "APNS", "CONVEX", "PAIR_CODE")) for key in inherited),
            "built test runner contains credential/provider configuration")
    require(not target.get("UITargetAppEnvironmentVariables"), "bootstrap driver cannot inherit app configuration or stale activation")
    require(isinstance(fixture_phone, str) and re.fullmatch(r"\+120255501\d{2}", fixture_phone), "reserved synthetic UI-only fixture phone required")
    require(0 < len(manifest_raw) <= 16_384, "bounded actual native manifest required")
    target["EnvironmentVariables"] = {"CALLED_IT_PROVISIONER_PHASE": "isolated-runtime", "CALLED_IT_PROVISIONER_RUN_ID": run,
                                      "CALLED_IT_PROVISIONER_SIMULATOR_UDID": simulator,
                                      "CALLED_IT_QA_RUN_ID": run, "CALLED_IT_QA_MANIFEST_BASE64": base64.b64encode(manifest_raw).decode(),
                                      "CALLED_IT_PROVISIONER_FIXTURE_PHONE": fixture_phone}
    target["OnlyTestIdentifiers"] = [METHOD.split("/", 1)[1]]
    target["SkipTestIdentifiers"] = []

    def rebase(value):
        if isinstance(value, str):
            return value.replace("__TESTROOT__", str(original_folder))
        if isinstance(value, dict):
            return {key: rebase(item) for key, item in value.items()}
        if isinstance(value, list):
            return [rebase(item) for item in value]
        return value

    return plistlib.dumps(rebase(payload), fmt=plistlib.FMT_XML, sort_keys=True)


def main():
    parser = argparse.ArgumentParser(description="Drive only a provisioner-owned fresh simulator synthetic compose; never send or sign in")
    parser.add_argument("--context", required=True)
    parser.add_argument("--xctestrun", required=True)
    parser.add_argument("--fixture-phone", required=True)
    args = parser.parse_args()
    context_path = Path(args.context)
    context = json.loads(regular(str(context_path), 65_536))
    require(context.get("version") == 1 and context.get("phase") == "isolated-runtime", "fresh provisioner isolated-runtime context required")
    folder = context_path.parent
    request = context["request"]
    raw = regular(args.xctestrun, 1_048_576)
    manifest_raw = regular(context["manifestPath"], 16_384)
    require(digest(manifest_raw) == context["manifestSHA256"], "raw manifest hash does not match externally recorded activation")
    rewritten = prepare_test_run(raw, Path(args.xctestrun).parent, request["runID"], context["simulatorUDID"], manifest_raw, args.fixture_phone)
    path = folder / "provisioning-driver.xctestrun"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(rewritten)
    result = subprocess.run(["/usr/bin/xcodebuild", "test-without-building", "-xctestrun", str(path),
                             "-destination", "platform=iOS Simulator,id=" + context["simulatorUDID"],
                             "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1",
                             "-only-testing:" + METHOD, "-resultBundlePath", str(folder / "provisioning-driver.xcresult")],
                            env=clean_environment(Path.home(), folder), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=540, check=False)
    write_new(folder / "provisioning-driver-command.json", {"runID": request["runID"], "simulatorUDID": context["simulatorUDID"],
              "originalXctestrunSHA256": digest(raw), "generatedXctestrunSHA256": digest(rewritten),
              "exit": result.returncode, "stdoutSHA256": digest(result.stdout), "stderrSHA256": digest(result.stderr), "method": METHOD})
    require(result.returncode == 0, "actual synthetic Messages/extension driver failed; inspect its run-owned xcresult, never replace it with host-only proof")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Provisioning UI driver BLOCKED: " + (str(error) if isinstance(error, Blocked) else type(error).__name__), file=sys.stderr)
        sys.exit(2)
