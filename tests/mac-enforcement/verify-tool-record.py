import argparse
import datetime
import hashlib
import json
import pathlib
import re
import uuid


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def verify_tool_continuity(logs, build_id, run_id, nonce, parent_observations):
    require(logs.get("build_id") == build_id and logs.get("status") == "succeeded", "actual expected tool build must have succeeded")
    run_id = str(uuid.UUID(run_id)).upper()
    nonce = str(uuid.UUID(nonce)).upper()
    require(run_id != nonce and uuid.UUID(nonce).version == 4, "independent actual run/launch nonce required")
    events = []
    for line in logs.get("log_lines", []):
        match = re.fullmatch(r"\[info\] (\S+) (CALLED_IT_[A-Z_]+) (.+)", line)
        if match:
            timestamp = datetime.datetime.fromisoformat(match[1].replace("Z", "+00:00"))
            require(timestamp.tzinfo is not None, "actual tool timestamp must include a timezone")
            events.append((int(timestamp.timestamp() * 1000), match[2], json.loads(match[3])))
    require(events, "actual structured tool events missing")

    def one(name):
        values = [(at, value) for at, key, value in events if key == name]
        require(len(values) == 1, "missing/duplicate actual tool event: " + name)
        return values[0]

    pre_at, pre = one("CALLED_IT_ENFORCEMENT_PRE_MUTATION")
    require(events[0][1] == "CALLED_IT_ENFORCEMENT_PRE_MUTATION" and
            events[-1][1] == "CALLED_IT_ENFORCEMENT_VERDICT" and all(left[0] <= right[0] for left, right in zip(events, events[1:])),
            "actual tool launch/record/verdict order is inconsistent")
    authorization = pre["authorization"]
    require(authorization["runID"] == run_id and authorization["launchNonce"] == nonce, "actual launch chain run/nonce mismatch")
    offset = pre_at - authorization["checkedAt"]
    require(abs(offset) <= 5000, "guest/tool clock relationship is not bounded")
    records = {}
    records_started = False
    for _, key, event in events:
        if key == "CALLED_IT_ENFORCEMENT_RECORD":
            records_started = True
            require(event["file"] not in records and re.fullmatch(r"[a-f0-9]{64}", event["sha256"]), "duplicate/unbounded actual record")
            name = event["file"]
            spaced = name in {"runner-authorized.json", "control-prepared.json", "lease-ready.json", "lease-cleanup.json", "lease-blocked.json", "device-approved.json"}
            encoded = json.dumps(event["value"], sort_keys=True, separators=(", ", ": ") if spaced or name == "heartbeat.json" else (",", ":"))
            raw = (encoded + ("" if name == "heartbeat.json" else "\n")).encode()
            require(hashlib.sha256(raw).hexdigest() == event["sha256"], "actual emitted record bytes/hash mismatch: " + name)
            records[event["file"]] = event["value"]
        if key == "CALLED_IT_CONTROL_CHANNEL_PROBE":
            require(not records_started, "actual record output cannot precede the stopped pulse stream")
    require({"lease-ready.json", "lease-cleanup.json", "network-verified.json", "completed.json"} <= set(records), "actual enforcement/cleanup records missing")
    ready, cleanup, proof, completed = [records[name] for name in ("lease-ready.json", "lease-cleanup.json", "network-verified.json", "completed.json")]
    require(all(value["runID"] == run_id for value in (ready, cleanup, proof, completed)), "actual record run mismatch")
    require(ready["runnerAuthorization"]["chainSHA256"] == authorization["chainSHA256"], "actual root chain mismatch")
    require(not {"blocked.json", "lease-blocked.json"}.intersection(records) and completed["status"] == "completed-and-owned-isolation-restored" and cleanup["failures"] == [] and cleanup["isolationRetained"] is False,
            "actual local denial/restoration gates did not complete")
    started, released = ready["recordedAt"], cleanup["enforcementReleaseStartedAt"]
    require(type(started) is int and type(released) is int and started < proof["verifiedAt"] <= released <= cleanup["recordedAt"], "actual enforced window bounds missing or inconsistent")
    _, verdict = one("CALLED_IT_ENFORCEMENT_VERDICT")
    require(verdict["runID"] == run_id and verdict["launchNonce"] == nonce and verdict["status"] == "local-gates-pass-parent-tool-continuity-pending" and
            type(verdict["probeExitCode"]) is int and verdict["probeExitCode"] == 0 and verdict["realProviderExecuted"] is False and
            verdict["parentToolContinuityVerified"] is False and verdict["testsExecuted"] == 0 and verdict["simulatorCreated"] is False and verdict["nativeUIExecuted"] is False and verdict["fullV0Ready"] is False,
            "operator claimed unsupported readiness or skipped independent parent continuity")
    pulses = []
    previous_sequence = -1
    previous_observed = -1
    previous_tool_at = -1
    for at, key, value in events:
        if key != "CALLED_IT_CONTROL_CHANNEL_PROBE":
            continue
        require(set(value) == {"version", "runID", "launchNonce", "sequence", "observedAt"} and value["version"] == 1 and
                value["runID"] == run_id and value["launchNonce"] == nonce and type(value["sequence"]) is int and type(value["observedAt"]) is int,
                "actual tool pulse schema/run/nonce mismatch")
        require(value["sequence"] > previous_sequence and value["observedAt"] > previous_observed and at > previous_tool_at,
                "actual tool pulses replayed, reordered or non-progressing")
        require(abs(at - value["observedAt"] - offset) <= 2000, "pulse was not retained promptly on the independent tool channel")
        previous_sequence, previous_observed, previous_tool_at = value["sequence"], value["observedAt"], at
        if started <= value["observedAt"] <= released:
            require(started - 1000 <= at - offset <= released + 1000, "tool pulse was not retained across the actual enforced window")
            pulses.append((at, value))
    require(len(pulses) >= 2, "insufficient actual tool-retained pulses during enforcement")
    points = [started, *[value["observedAt"] for _, value in pulses], released]
    tool_points = [started + offset, *[at for at, _ in pulses], released + offset]
    require(all(0 <= right - left < 8000 for values in (points, tool_points) for left, right in zip(values, values[1:])), "actual tool continuity has a stale enforced-window gap")
    require(parent_observations.get("version") == 1 and parent_observations.get("buildID") == build_id and
            isinstance(parent_observations.get("samples"), list), "independent parent live tool observations missing")
    emitted = {value["sequence"]: value for _, key, value in events if key == "CALLED_IT_CONTROL_CHANNEL_PROBE"}
    seen = set()
    received = []
    previous_return = -1
    for sample in parent_observations["samples"]:
        before, after = sample["callStartedAt"], sample["callReturnedAt"]
        result = sample["toolResult"]
        require(type(before) is int and type(after) is int and previous_return <= before <= after and result["build_id"] == build_id,
                "independent parent receipt chronology/build mismatch")
        previous_return = after
        for line in result["log_lines"]:
            if "CALLED_IT_CONTROL_CHANNEL_PROBE " not in line:
                continue
            value = json.loads(line.split("CALLED_IT_CONTROL_CHANNEL_PROBE ", 1)[1])
            require(value["sequence"] in emitted and emitted[value["sequence"]] == value, "parent receipt is not in the actual final tool transcript")
            if value["sequence"] in seen:
                continue
            seen.add(value["sequence"])
            if result["status"] == "running" and started <= before <= after <= released and started <= value["observedAt"] <= released:
                require(-1000 <= after - value["observedAt"] < 8000, "independent parent did not receive a fresh live pulse")
                received.append(after)
    require(len(set(received)) >= 2, "actual independent parent received no progressing tool output during enforcement")
    receipt_points = [started, *sorted(set(received)), released]
    require(all(0 <= right - left < 8000 for left, right in zip(receipt_points, receipt_points[1:])), "independent parent receipt coverage has a stale enforced-window gap")
    return {"version": 1, "buildID": build_id, "runID": run_id, "launchNonce": nonce, "enforcementStartedAt": started,
            "enforcementReleaseStartedAt": released, "actualToolPulseCountDuringEnforcement": len(pulses), "parentToolContinuityVerified": True,
            "independentParentLiveReceiptCount": len(set(received)),
            "scope": "parent analysis of actual supplied live tool responses and independent parent receipt clocks against root-observed UTC window; provider-prefix timestamps alone are not receipt authority; not cryptographic time/platform attestation or arbitrary non-IP/covert-channel proof",
            "managementChannel": "intentional provider vsock", "testsExecuted": 0, "nativeUIExecuted": False, "fullV0Ready": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--actual-tool-logs", required=True)
    parser.add_argument("--actual-parent-observations", required=True)
    parser.add_argument("--expected-build-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--launch-nonce", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = verify_tool_continuity(json.loads(pathlib.Path(args.actual_tool_logs).read_bytes()), args.expected_build_id, args.run_id, args.launch_nonce,
                                    json.loads(pathlib.Path(args.actual_parent_observations).read_bytes()))
    with pathlib.Path(args.output).open("x") as file:
        json.dump(result, file, indent=2)
        file.write("\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
