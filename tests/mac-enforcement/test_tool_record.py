import copy
import datetime
import hashlib
import importlib.util
import json
import pathlib
import unittest


SPEC = importlib.util.spec_from_file_location("parent_tool_analysis", pathlib.Path(__file__).with_name("verify-tool-record.py"))
ANALYSIS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ANALYSIS)
RUN = "11111111-1111-4111-8111-111111111111"
NONCE = "22222222-2222-4222-8222-222222222222"


def fake_logs():
    lines = []

    def emit(at, key, value):
        timestamp = datetime.datetime.fromtimestamp(at / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        lines.append("[info] " + timestamp + " " + key + " " + json.dumps(value))

    auth = {"runID": RUN, "launchNonce": NONCE, "chainSHA256": "a" * 64, "checkedAt": 100000}
    emit(100100, "CALLED_IT_ENFORCEMENT_PRE_MUTATION", {"authorization": auth})
    for sequence, at in enumerate(range(100000, 112001, 2000)):
        emit(at + 100, "CALLED_IT_CONTROL_CHANNEL_PROBE", {"version": 1, "runID": RUN, "launchNonce": NONCE, "sequence": sequence, "observedAt": at})
    for name, value in {
        "lease-ready.json": {"runID": RUN, "recordedAt": 101000, "runnerAuthorization": auth},
        "lease-cleanup.json": {"runID": RUN, "enforcementReleaseStartedAt": 111000, "recordedAt": 112000, "failures": [], "isolationRetained": False},
        "network-verified.json": {"runID": RUN, "verifiedAt": 109000},
        "completed.json": {"runID": RUN, "status": "completed-and-owned-isolation-restored"},
    }.items():
        spaced = name in {"lease-ready.json", "lease-cleanup.json"}
        raw = (json.dumps(value, sort_keys=True, separators=(", ", ": ") if spaced else (",", ":")) + "\n").encode()
        emit(112200, "CALLED_IT_ENFORCEMENT_RECORD", {"file": name, "value": value, "sha256": hashlib.sha256(raw).hexdigest()})
    emit(112300, "CALLED_IT_ENFORCEMENT_VERDICT", {"runID": RUN, "launchNonce": NONCE, "status": "local-gates-pass-parent-tool-continuity-pending",
        "parentToolContinuityVerified": False, "probeExitCode": 0, "realProviderExecuted": False, "testsExecuted": 0, "simulatorCreated": False, "nativeUIExecuted": False, "fullV0Ready": False})
    return {"build_id": "FAKE_DESIGN_ONLY_BUILD", "status": "succeeded", "log_lines": lines}


class FakeParentToolAnalysisDesignTests(unittest.TestCase):
    def check(self, logs, observations=None):
        if observations is None:
            samples = []
            for line in fake_logs()["log_lines"]:
                if "CALLED_IT_CONTROL_CHANNEL_PROBE " in line:
                    value = json.loads(line.split("CALLED_IT_CONTROL_CHANNEL_PROBE ", 1)[1])
                    samples.append({"callStartedAt": value["observedAt"] + 100, "callReturnedAt": value["observedAt"] + 200,
                                    "toolResult": {"build_id": "FAKE_DESIGN_ONLY_BUILD", "status": "running", "log_lines": [line]}})
            observations = {"version": 1, "buildID": "FAKE_DESIGN_ONLY_BUILD", "samples": samples}
        return ANALYSIS.verify_tool_continuity(logs, "FAKE_DESIGN_ONLY_BUILD", RUN, NONCE, observations)

    def test_PARENT_TOOL_01_synthetic_transcript_shape_passes_only_design_analysis(self):
        value = self.check(fake_logs())
        self.assertEqual(value["actualToolPulseCountDuringEnforcement"], 5)
        self.assertFalse(value["fullV0Ready"])
        self.assertIn("not cryptographic", value["scope"])
        self.assertEqual(value["independentParentLiveReceiptCount"], 5)

    def test_PARENT_TOOL_02_no_actual_output_cannot_be_replaced_by_local_ready_records(self):
        logs = fake_logs()
        logs["log_lines"] = [line for line in logs["log_lines"] if "CONTROL_CHANNEL_PROBE" not in line]
        with self.assertRaisesRegex(RuntimeError, "insufficient actual tool"):
            self.check(logs)

    def test_PARENT_TOOL_03_wrong_build_or_failed_tool_never_passes(self):
        for field, value in (("build_id", "OTHER_FAKE_BUILD"), ("status", "failed")):
            logs = fake_logs()
            logs[field] = value
            with self.assertRaises(RuntimeError):
                self.check(logs)

    def test_PARENT_TOOL_04_wrong_nonce_or_stale_gap_never_passes(self):
        for mode in ("wrong nonce", "gap"):
            logs = fake_logs()
            if mode == "wrong nonce":
                logs["log_lines"] = [line.replace(NONCE, RUN) if "CONTROL_CHANNEL_PROBE" in line else line for line in logs["log_lines"]]
            else:
                logs["log_lines"] = [line for line in logs["log_lines"] if "CONTROL_CHANNEL_PROBE" not in line or any('"sequence": ' + str(i) + "," in line for i in (0, 1, 5, 6))]
            with self.assertRaises(RuntimeError):
                self.check(logs)

    def test_PARENT_TOOL_05_replayed_or_buffered_output_never_passes(self):
        for mode in ("replay", "buffer"):
            logs = fake_logs()
            if mode == "replay":
                logs["log_lines"].insert(3, logs["log_lines"][2])
            else:
                logs["log_lines"] = [line.replace("00:01:42.100000Z", "00:02:42.100000Z") for line in logs["log_lines"]]
            with self.assertRaises(RuntimeError):
                self.check(logs)

    def test_PARENT_TOOL_06_missing_cleanup_or_unsupported_readiness_never_passes(self):
        for mode in ("cleanup", "readiness"):
            logs = copy.deepcopy(fake_logs())
            if mode == "cleanup":
                logs["log_lines"] = [line for line in logs["log_lines"] if '"file": "lease-cleanup.json"' not in line]
            else:
                logs["log_lines"] = [line.replace('"fullV0Ready": false', '"fullV0Ready": true') for line in logs["log_lines"]]
            with self.assertRaises(RuntimeError):
                self.check(logs)

    def test_PARENT_TOOL_07_retained_tool_gaps_are_bounded_independently_of_guest_times(self):
        logs = fake_logs()
        keep = []
        for line in logs["log_lines"]:
            if "CONTROL_CHANNEL_PROBE" not in line:
                keep.append(line)
            elif '"sequence": 1,' in line:
                keep.append(line.replace("00:01:42.100000Z", "00:01:41.100000Z"))
            elif '"sequence": 4,' in line:
                keep.append(line.replace("00:01:48.100000Z", "00:01:49.100000Z"))
        logs["log_lines"] = keep
        with self.assertRaisesRegex(RuntimeError, "stale enforced-window gap"):
            self.check(logs)

    def test_PARENT_TOOL_08_pre_mutation_after_final_verdict_never_passes(self):
        logs = fake_logs()
        logs["log_lines"].append(logs["log_lines"].pop(0))
        with self.assertRaisesRegex(RuntimeError, "order is inconsistent"):
            self.check(logs)

    def test_PARENT_TOOL_09_wrong_raw_record_hash_never_passes(self):
        logs = fake_logs()
        for index, line in enumerate(logs["log_lines"]):
            if '"file": "lease-ready.json"' in line:
                prefix, raw = line.split("CALLED_IT_ENFORCEMENT_RECORD ", 1)
                record = json.loads(raw)
                record["sha256"] = "0" * 64
                logs["log_lines"][index] = prefix + "CALLED_IT_ENFORCEMENT_RECORD " + json.dumps(record)
        with self.assertRaisesRegex(RuntimeError, "bytes/hash mismatch"):
            self.check(logs)

    def test_PARENT_TOOL_10_contradictory_exit_or_provider_flags_never_pass(self):
        for before, after in (('"probeExitCode": 0', '"probeExitCode": 1'), ('"realProviderExecuted": false', '"realProviderExecuted": true')):
            logs = fake_logs()
            logs["log_lines"] = [line.replace(before, after) for line in logs["log_lines"]]
            with self.assertRaises(RuntimeError):
                self.check(logs)

    def test_PARENT_TOOL_11_records_before_pulses_never_pass(self):
        logs = fake_logs()
        lines = logs["log_lines"]
        logs["log_lines"] = [lines[0], *[line for line in lines if "ENFORCEMENT_RECORD" in line], *[line for line in lines if "CONTROL_CHANNEL_PROBE" in line], lines[-1]]
        with self.assertRaisesRegex(RuntimeError, "order is inconsistent"):
            self.check(logs)

    def test_PARENT_TOOL_12_provider_timestamp_strings_without_live_parent_receipts_never_pass(self):
        observations = {"version": 1, "buildID": "FAKE_DESIGN_ONLY_BUILD", "samples": []}
        with self.assertRaisesRegex(RuntimeError, "independent parent received"):
            self.check(fake_logs(), observations)

    def test_PARENT_TOOL_13_post_release_batch_receipt_never_passes(self):
        lines = [line for line in fake_logs()["log_lines"] if "CONTROL_CHANNEL_PROBE" in line]
        observations = {"version": 1, "buildID": "FAKE_DESIGN_ONLY_BUILD", "samples": [
            {"callStartedAt": 112100, "callReturnedAt": 112200, "toolResult": {"build_id": "FAKE_DESIGN_ONLY_BUILD", "status": "running", "log_lines": lines}}]}
        with self.assertRaisesRegex(RuntimeError, "independent parent received"):
            self.check(fake_logs(), observations)


if __name__ == "__main__":
    unittest.main()
