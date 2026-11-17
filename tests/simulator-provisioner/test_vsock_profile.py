import ast
import copy
import json
import os
import tempfile
import time
import unittest
import subprocess
import sys
import inspect
from pathlib import Path
from unittest.mock import Mock, patch

import global_pf
import provision
import root_capsule
import vsock_control as v


RUN = "11111111-2222-4333-8444-555555555555"
NONCE = "77777777-8888-4999-AAAA-BBBBBBBBBBBB"


class SyntheticVsockDesignTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="UNIT-NO-MAC-VSOCK-")
        self.folder = Path(self.temporary.name).resolve()
        self.profile, self.profile_sha = v.load_profile()
        self.ancestry = [{"pid": 91, "parentPID": 22, "executable": "/UNIT/python"},
                         {"pid": 22, "parentPID": 1, "executable": self.profile["agentPath"]}]
        stream = {"fd": 7, "family": 40, "kind": 7, "type": 1, "protocol": 0, "state": 258, "connected": True,
                  "localCID": 12, "localPort": 8080, "remoteCID": 2, "remotePort": 987654321}
        self.payload = {**self.profile["sdkConstants"], "processes": [
            {"pid": item["pid"], "parentPID": item["parentPID"], "uid": 501, "birthSeconds": 123456, "birthMicroseconds": 123,
             "identityStable": True, "sockets": [stream] if item["pid"] == 22 else []} for item in self.ancestry]}
        self.table = "Active VSock sockets\nProto Type Recv-Q Send-Q Local Address Foreign Address State\nvsock stream 0 0 *:8080 *:* LISTEN\nvsock stream 0 0 12:8080 2:987654321 ESTABLISHED\n"

    def tearDown(self):
        self.temporary.cleanup()

    def typed(self, payload=None, table=None):
        return v.typed_observation(payload or self.payload, self.ancestry, 22, v.netstat_connections(table or self.table), self.profile)

    def test_SIM_VSOCK_01_synthetic_typed_connected_fd_requires_matching_kernel_tuple(self):
        observed = self.typed()
        self.assertEqual(observed["connections"][0]["localCID"], 12)
        self.assertEqual(observed["connections"][0]["remotePort"], 987654321)
        for change in ({"family": 2}, {"kind": 1}, {"type": 2}, {"protocol": 6}, {"connected": False}, {"state": 256},
                       {"localCID": 4294967295}, {"remoteCID": 3}, {"localPort": 443}, {"remotePort": 1}):
            payload = copy.deepcopy(self.payload)
            payload["processes"][1]["sockets"][0].update(change)
            with self.subTest(change=change), self.assertRaises(provision.Blocked):
                self.typed(payload)

    def test_SIM_VSOCK_02_synthetic_empty_listener_error_truncation_and_reuse_never_admit(self):
        for change in ({"sockets": []}, {"identityStable": False}, {"inspectionErrno": 1}, {"parentPID": 999},
                       {"birthSeconds": 0}, {"birthMicroseconds": 1_000_000}):
            payload = copy.deepcopy(self.payload)
            payload["processes"][1].update(change)
            with self.subTest(change=change), self.assertRaises(provision.Blocked):
                self.typed(payload)
        for table in ("no TCP sockets", self.table.replace("12:8080", "99:8080"), self.table.replace("ESTABLISHED", "CLOSING")):
            with self.assertRaises(provision.Blocked):
                self.typed(table=table)
        payload = copy.deepcopy(self.payload)
        payload["processes"][1]["sockets"].append(dict(payload["processes"][1]["sockets"][0]))
        with self.assertRaises(provision.Blocked):
            self.typed(payload)

    def test_SIM_VSOCK_03_no_ip_plan_has_only_numeric_loopback_passes(self):
        _, rules = global_pf.plan_no_ip_rules(RUN)
        passes = [line for line in rules.splitlines() if line.startswith("pass")]
        self.assertEqual(passes, ["pass quick on lo0 inet from 127.0.0.1 to 127.0.0.1 no state", "pass quick on lo0 inet6 from ::1 to ::1 no state"])
        self.assertNotIn("_control_", rules)
        with self.assertRaises(global_pf.IsolationUnproven):
            global_pf.require_no_unowned_states("all tcp 10.0.0.1:123 -> 10.0.0.2:443 ESTABLISHED:ESTABLISHED", [])

    def test_SIM_VSOCK_04_local_pulse_requires_current_nonce_private_path_and_fresh_time(self):
        path = self.folder / "pulse.json"
        authorization = {"runID": RUN, "launchNonce": NONCE}
        value = {"version": 1, **authorization, "sequence": 4, "observedAt": int(time.time() * 1000)}
        for change in ({}, {"runID": NONCE}, {"launchNonce": RUN}, {"sequence": True}, {"observedAt": 0}, {"externalDelivery": True}):
            path.write_text(json.dumps({**value, **change}))
            path.chmod(0o600)
            if change:
                with self.assertRaises(provision.Blocked):
                    v.read_pulse(str(path), authorization, os.getuid())
            else:
                self.assertEqual(v.read_pulse(str(path), authorization, os.getuid()), value)
        path.write_text(json.dumps(value))
        path.chmod(0o644)
        with self.assertRaises(provision.Blocked):
            v.read_pulse(str(path), authorization, os.getuid())

    def test_SIM_VSOCK_05_nonprogressing_or_decreasing_pulse_blocks_root_watchdog(self):
        control = object.__new__(v.RootControl)
        control.helper = Mock()
        control.helper.stat.return_value = type("Info", (), {"st_uid": 0, "st_mode": 0o100500})()
        control.runtime = {"helperSHA256": provision.digest(b"UNIT HELPER")}
        control.owner_pid = 91
        control.requested_pids = [22]
        control.profile = self.profile
        control.command = Mock()
        control.baseline = {"classification": "UNIT SYNTHETIC ONLY"}
        control.pulse_path = "/UNIT/pulse"
        control.authorization = {"runID": RUN, "launchNonce": NONCE}
        control.owner_uid = 501
        control.last_pulse = {"sequence": 4, "observedAt": 4000}
        control.progress_at = 0
        for pulse in ({"sequence": 3, "observedAt": 5000}, {"sequence": 4, "observedAt": 4000}):
            with patch.object(v, "regular", return_value=b"UNIT HELPER"), patch.object(v, "observe", return_value=control.baseline), \
                    patch.object(v, "read_pulse", return_value=pulse), patch.object(v.time, "monotonic", return_value=9), self.assertRaises(provision.Blocked):
                control.check()

    def test_SIM_VSOCK_06_mutable_or_unsealed_helper_claim_is_not_privileged_authority(self):
        authorization = {"launchNonce": NONCE, "chainSHA256": "a" * 64, "guestBootSessionUUID": RUN}
        helper = v.HELPERS / NONCE / "control-sockets"
        runtime = {"helperPath": str(helper), "launchChainSHA256": "a" * 64, "rootLaunchWitnessSHA256": "b" * 64,
                   "rootGuardPID": 535, "ownerPID": 91, "guestBootSessionUUID": RUN}
        ready = {"controlRuntime": runtime, "leasePID": 535, "ownerPID": 91, "controlRuntimeSHA256": "c" * 64}
        command = Mock(return_value="501:755:Regular File")
        with self.assertRaises(provision.Blocked):
            v.live_control(ready, authorization, "b" * 64, command)
        self.assertTrue(all("control-sockets" not in call.args[0][2:3] for call in command.call_args_list))
        command.reset_mock()
        ready["controlRuntime"] = {**runtime, "helperPath": "/UNIT/user-writable-helper"}
        with self.assertRaises(provision.Blocked):
            v.live_control(ready, authorization, "b" * 64, command)
        command.assert_not_called()

    def test_SIM_VSOCK_07_compiler_paths_with_unprivileged_writable_ancestors_are_refused(self):
        path = self.folder / "UNIT-clang"
        path.write_text("UNIT NOT AN EXECUTABLE")
        with patch.object(v.subprocess, "run", return_value=type("Result", (), {"returncode": 0, "stdout": b"UNIT header\n"})()), self.assertRaisesRegex(provision.Blocked, "nonroot-writable.*uid=.*mode="):
            v.trusted_path(path)

    def test_SIM_CAPSULE_01_bootstrap_is_literal_stdlib_only_and_never_executes_workspace_code(self):
        tree = ast.parse(root_capsule.ROOT_BOOTSTRAP)
        imports = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertEqual(imports, {"hashlib", "json", "os", "stat", "subprocess", "sys", "uuid"})
        self.assertIn("os.O_NOFOLLOW", root_capsule.ROOT_BOOTSTRAP)
        self.assertIn("os.O_EXCL", root_capsule.ROOT_BOOTSTRAP)
        self.assertIn("sha(read(source/name))==pin", root_capsule.ROOT_BOOTSTRAP)
        self.assertIn("sha(read(capsule/name))==pin", root_capsule.ROOT_BOOTSTRAP)
        self.assertIn("'-I','-S','-c',launcher", root_capsule.ROOT_BOOTSTRAP)
        self.assertIn("lease=harness/'lease.py'", root_capsule.ROOT_BOOTSTRAP)
        source = Path(provision.__file__).read_text()
        self.assertNotIn('"-E", "-s", script', source)
        self.assertIn('"-I", "-S", "-c", bootstrap', source)
        self.assertIn('ast.Constant', Path(root_capsule.__file__).read_text())

    def test_SIM_VSOCK_08_observed_relative_sudo_label_is_not_an_invented_executable_path(self):
        command = Mock(side_effect=["22 sudo\n", "1 " + self.profile["agentPath"] + "\n"])
        records = v.ancestry(91, command)
        self.assertEqual(records[0]["executable"], "sudo")
        self.assertEqual(records[1]["executable"], self.profile["agentPath"])
        with self.assertRaises(provision.Blocked):
            v.ancestry(91, Mock(return_value="22 unknown-label\n"))

    def test_SIM_CAPSULE_02_extracts_only_exact_hash_pinned_literal_and_rejects_changed_module_bytes(self):
        root = self.folder / "UNIT-archive"
        harness = root / "tests/simulator-provisioner"
        harness.mkdir(parents=True)
        name = "tests/simulator-provisioner/root_capsule.py"
        copy = root / name
        original = Path(root_capsule.__file__).read_bytes()
        copy.write_bytes(original)
        manifest_raw = json.dumps({"files": {name: provision.digest(original)}}).encode()
        manifest = root / "manifest.json"
        manifest.write_bytes(manifest_raw)
        context = root / "context.json"
        context.write_text(json.dumps({"sourceManifest": {"file": manifest.name, "sha256": provision.digest(manifest_raw)}}))
        with patch.object(root_capsule, "__file__", str(copy)):
            literal, pin = root_capsule.pinned_bootstrap(str(context), provision.digest(context.read_bytes()))
            self.assertEqual(literal, root_capsule.ROOT_BOOTSTRAP)
            self.assertEqual(pin, provision.digest(manifest_raw))
            copy.write_bytes(b"raise RuntimeError('UNIT must never execute changed bytes')\n" + original)
            with self.assertRaises(provision.Blocked):
                root_capsule.pinned_bootstrap(str(context), provision.digest(context.read_bytes()))

    def test_SIM_READER_01_fifo_reads_fail_promptly_in_bounded_isolated_subprocesses(self):
        fifo = self.folder / "UNIT-fifo"
        os.mkfifo(fifo, 0o600)
        ordinary = "import sys\nsys.path.insert(0," + repr(str(Path(provision.__file__).parent)) + ")\nfrom provision import regular\n"
        tree = ast.parse(root_capsule.ROOT_BOOTSTRAP)
        reader = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))], type_ignores=[])
        capsule = ast.unparse(reader) + "\n"
        for prefix, expression in ((ordinary, "regular(" + repr(str(fifo)) + ")"), (capsule, "read(" + repr(str(fifo)) + ")")):
            code = prefix + "try:\n " + expression + "\nexcept RuntimeError:\n pass\nelse:\n raise AssertionError('FIFO accepted')\n"
            result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", code], stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_SIM_PFTREE_01_only_owned_rule_insertion_survives_recursive_tree_diff(self):
        anchor, rules = global_pf.plan_no_ip_rules(RUN)
        baseline = 'anchor "com.apple/*" all {\n anchor "250.ApplicationFirewall" all {\n }\n}\n'
        owned = ' anchor "' + anchor.split('/')[-1] + '" all {\n' + rules + '}\n'
        active = baseline.rsplit("}", 1)[0] + owned + "}\n"
        global_pf.verify_owned_tree(baseline, active, anchor, rules)
        for changed in (active.replace('anchor "250.', 'anchor "foreign250.'), active.replace(rules, rules + "pass out quick all\n"),
                        active.replace("}\n", "pass out quick all\n}\n", 1), active + "}", active.replace(owned, "")):
            with self.assertRaises(global_pf.IsolationUnproven):
                global_pf.verify_owned_tree(baseline, changed, anchor, rules)
        global_pf.verify_anchor_insertion("250.ApplicationFirewall\n", "250.ApplicationFirewall\n" + anchor.split('/')[-1] + "\n", anchor)
        with self.assertRaises(global_pf.IsolationUnproven):
            global_pf.verify_anchor_insertion("250.ApplicationFirewall\n", "foreign\n" + anchor.split('/')[-1] + "\n", anchor)

    def test_SIM_SDK_01_full_system_dependency_format_is_bounded_and_strict(self):
        text = "calledit-helper: /ROOT/control.c \\\n /SDK/usr/include/libproc.h\n"
        self.assertEqual(v.dependency_paths(text), ["/ROOT/control.c", "/SDK/usr/include/libproc.h"])
        for value in ("", "other-target: /ROOT/control.c", "calledit-helper: relative.h", "calledit-helper: /ROOT/a.h\n /ROOT/b.h\n",
                      "calledit-helper: /ROOT/a.h /ROOT/a.h", "calledit-helper: /ROOT/../a.h", "calledit-helper: /SDK/escaped\\ file.h"):
            with self.assertRaises(provision.Blocked):
                v.dependency_paths(value)

    def test_SIM_SDK_02_header_bytes_and_ownership_are_checked_before_generated_helper_can_execute(self):
        source = self.folder / "control.c"
        sdk = self.folder / "SDK"
        resources = self.folder / "resources"
        sdk.mkdir()
        resources.mkdir()
        header = sdk / "header.h"
        source.write_text("UNIT sealed C")
        header.write_text("UNIT header before")
        text = "calledit-helper: " + str(source) + " " + str(header) + "\n"
        with patch.object(v, "trusted_path", side_effect=lambda path, **_kwargs: Path(path)):
            before = v.dependency_seal(text, source, sdk, resources)
            header.write_text("UNIT header after")
            self.assertNotEqual(v.dependency_seal(text, source, sdk, resources), before)
        def untrusted(path, **_kwargs):
            if Path(path) == header:
                raise provision.Blocked("UNIT header owner UID501")
            return Path(path)
        with patch.object(v, "trusted_path", side_effect=untrusted), self.assertRaises(provision.Blocked):
            v.dependency_seal(text, source, sdk, resources)
        constructor = inspect.getsource(v.RootControl.__init__)
        self.assertIn('"-M"', constructor)
        self.assertIn('"-MD"', constructor)
        self.assertNotIn('"-MM"', constructor)
        self.assertLess(constructor.index("dependency_seal(actual_dependencies_raw"), constructor.index("self.baseline = self.observation()"))

    def test_SIM_CAPSULE_03_node_status_python_literal_is_isolated_and_syntax_valid(self):
        source = (Path(__file__).parent / "controller.ts").read_text()
        literal = source.split("const protectedStatusBootstrap = String.raw`", 1)[1].split("`;", 1)[0]
        ast.parse(literal)
        self.assertIn("os.O_NONBLOCK", literal)
        self.assertIn("capsule/'tests/simulator-provisioner'", literal)
        self.assertIn("runtime['ownerUID']", literal)
        self.assertIn("outputDirectoryIdentity", literal)
        self.assertNotIn("context.harnessDirectory", literal)


if __name__ == "__main__":
    unittest.main()
