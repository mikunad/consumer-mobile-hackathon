import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


SOURCE = pathlib.Path(__file__).with_name("enforcement-entry.py")
SPEC = importlib.util.spec_from_file_location("enforcement_entry_design_only", SOURCE)
ENTRY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENTRY)


class FakeArchiveEntryDesignTests(unittest.TestCase):
    def test_OPERATOR_CONTROL_01_pulse_follows_flushed_output_and_is_not_delivery_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "pulse.json"

            def emitted(name, value):
                self.assertEqual(name, "CALLED_IT_CONTROL_CHANNEL_PROBE")
                self.assertFalse(path.exists())
                self.assertEqual(value, {"version": 1, "runID": "FAKE_RUN", "launchNonce": "FAKE_NONCE", "sequence": 4, "observedAt": 123000})

            with patch.object(ENTRY.time, "time", return_value=123), patch.object(ENTRY, "emit", side_effect=emitted):
                value = ENTRY.emit_control_pulse(path, "FAKE_RUN", "FAKE_NONCE", 4)
            self.assertEqual(json.loads(path.read_bytes()), value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(path.with_suffix(".next").exists())

    def test_OPERATOR_CONTROL_02_failed_output_does_not_publish_a_pulse(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "pulse.json"
            with patch.object(ENTRY, "emit", side_effect=BrokenPipeError), self.assertRaises(BrokenPipeError):
                ENTRY.emit_control_pulse(path, "FAKE_RUN", "FAKE_NONCE", 0)
            self.assertFalse(path.exists())

    def test_OPERATOR_CARRIER_01_generates_only_in_private_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            (root / "native-imessage").mkdir()
            (root / "native-imessage/Info.plist").write_text("sealed original")
            scratch = root / "scratch"
            scratch.mkdir()
            environment = ENTRY.build_environment(scratch)

            def compile_fake(argv, **options):
                self.assertEqual(options["cwd"], scratch / "native")
                self.assertEqual(options["env"], environment)
                (scratch / "native/Info.plist").write_text("FAKE generated content")
                if argv[0] == "xcodebuild":
                    (scratch / "native/build/Build/Products/QA-iphonesimulator/CalledItMessages.app").mkdir(parents=True)
                return SimpleNamespace(returncode=0)

            with patch.object(ENTRY.subprocess, "run", side_effect=compile_fake):
                destination = ENTRY.build_carrier(root, scratch, environment)
            self.assertEqual((root / "native-imessage/Info.plist").read_text(), "sealed original")
            self.assertEqual(destination, root / "out/CalledItMessages.app")
            self.assertTrue(destination.is_dir())

    def test_OPERATOR_ENV_01_derives_build_username_without_inheriting_credentials(self):
        user = SimpleNamespace(pw_name="SYNTHETIC_RUNNER", pw_dir="/synthetic/home")
        with patch.object(ENTRY.pwd, "getpwuid", return_value=user), patch.dict(ENTRY.os.environ, {"ANTHROPIC_API_KEY": "FAKE_SECRET_MUST_NOT_LEAK", "USER": "UNTRUSTED_NAME"}):
            environment = ENTRY.build_environment(pathlib.Path("/synthetic/tmp"))
        self.assertEqual(environment["USER"], "SYNTHETIC_RUNNER")
        self.assertEqual(environment["LOGNAME"], "SYNTHETIC_RUNNER")
        self.assertEqual(environment["HOME"], "/synthetic/home")
        self.assertEqual(set(environment), {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"})

    def exercise(self, manifest, nonce="FAKE_NONCE", supplied_sha=None, sealed=b"original"):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            (root / "launch-proof").mkdir()
            raw = json.dumps(manifest).encode()
            (root / "launch-proof/source-manifest.json").write_bytes(raw)
            (root / "probe-config.json").write_text(json.dumps({"runID": "FAKE_RUN", "launchNonce": "FAKE_NONCE"}))
            (root / "sealed.txt").write_bytes(sealed)
            with patch.object(ENTRY, "__file__", str(root / "tests/mac-enforcement/enforcement-entry.py")), \
                    patch.object(sys, "argv", ["entry", "--launch-nonce", nonce, "--source-manifest-sha256", supplied_sha or hashlib.sha256(raw).hexdigest()]), \
                    patch.object(ENTRY.subprocess, "run", side_effect=AssertionError("design test must never execute a command")):
                ENTRY.main()

    def test_OPERATOR_SEAL_01_raw_hash_mismatch_stops_before_any_command(self):
        with self.assertRaisesRegex(RuntimeError, "source seal differs"):
            self.exercise({}, supplied_sha="0" * 64)

    def test_OPERATOR_SEAL_02_wrong_nonce_stops_before_any_command(self):
        with self.assertRaisesRegex(RuntimeError, "not this unique launch"):
            self.exercise({"launchNonce": "FAKE_NONCE", "runID": "FAKE_RUN"}, nonce="OTHER_FAKE_NONCE")

    def test_OPERATOR_SEAL_03_changed_archived_bytes_stop_before_any_command(self):
        manifest = {"launchNonce": "FAKE_NONCE", "runID": "FAKE_RUN", "files": {"sealed.txt": hashlib.sha256(b"original").hexdigest()}}
        with self.assertRaisesRegex(RuntimeError, "Archived input changed"):
            self.exercise(manifest, sealed=b"changed")


if __name__ == "__main__":
    unittest.main()
