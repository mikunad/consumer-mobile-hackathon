import json
import contextlib
import os
import plistlib
import subprocess
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import drive
import provision as p
import global_pf as firewall
import lease
import netprobe
import job
import launch_provenance
import status as provisioning_status
import vsock_control
import root_capsule


RUN = "11111111-2222-4333-8444-555555555555"
SIMULATOR = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"


def unit_request():
    return {"runID": RUN, "nativeSourceRevision": "a" * 40, "backendSourceRevision": "b" * 40,
            "fixtureSetID": "UNIT-FABRICATED-NO-SIMULATOR", "configVersion": "unit-v1",
            "runtimeID": "com.apple.CoreSimulator.SimRuntime.iOS-27-0", "deviceTypeID": "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            "apiPort": 8199, "cardPort": 3211, "lifetimeSeconds": 600, "appPath": "/UNIT-NOT-REAL/CalledItMessages.app",
            "nativeBuildRecord": "/UNIT-NOT-REAL/native.json", "backendBuildRecord": "/UNIT-NOT-REAL/backend.json",
            "controlPIDs": [91], "sourceCardOrigin": "https://cards.qa-runtime.invalid"}


class ProvisionerUnitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="UNIT-NO-SIMULATOR-")
        self.folder = Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def request_file(self, value):
        path = self.folder / "unit-request.json"
        path.write_text(json.dumps(value))
        return str(path)

    def test_SIM_GUARD_01_exact_request_and_no_secret_or_manifest_boolean_override(self):
        self.assertEqual(p.load_request(self.request_file(unit_request()))["runID"], RUN)
        for extra in ("token", "phone", "otp", "erasedSimulator", "outboundNetworkDenied"):
            with self.subTest(extra=extra), self.assertRaises(p.Blocked):
                p.load_request(self.request_file({**unit_request(), extra: True}))

    def test_SIM_GUARD_02_rejects_bad_ports_pins_lifetime_and_controller_identity(self):
        for change in ({"apiPort": 0}, {"cardPort": True}, {"lifetimeSeconds": 3601}, {"nativeSourceRevision": "main"},
                       {"controlPIDs": []}, {"controlPIDs": [True]}, {"controlPIDs": [1]},
                       {"sourceCardOrigin": "https://cards.qa-source.invalid"}, {"sourceCardOrigin": "https://cards.qa-runtime.invalid/"}):
            with self.subTest(change=change), self.assertRaises(p.Blocked):
                p.load_request(self.request_file({**unit_request(), **change}))

    def test_SIM_GUARD_03_regular_artifacts_reject_symlinks_empty_and_traversal(self):
        target = self.folder / "record.json"
        target.write_text("unit")
        linked = self.folder / "link.json"
        linked.symlink_to(target)
        for path in (str(linked), str(self.folder / ".." / self.folder.name / "record.json")):
            with self.assertRaises(p.Blocked):
                p.regular(path)
        target.write_bytes(b"")
        with self.assertRaises(p.Blocked):
            p.regular(str(target))

    def test_SIM_GUARD_04_fresh_records_are_exclusive_and_hash_exact_bytes(self):
        path = self.folder / "exclusive.json"
        expected = p.write_new(path, {"unitOnly": "NO ACTUAL SIMULATOR EVIDENCE"})
        self.assertEqual(expected, p.digest(path.read_bytes()))
        with self.assertRaises(FileExistsError):
            p.write_new(path, {"overwrite": True})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def unit_flows(self):
        return firewall.controller_flows("p91\nccontroller\nu501\nf12u\nPTCP\nn10.0.0.2:50001->203.0.113.7:443\nTST=ESTABLISHED\n", [91])

    def test_SIM_EGRESS_01_global_anchor_preserves_only_actual_existing_control_tuple(self):
        anchor, rules = firewall.plan_rules(RUN, self.unit_flows())
        self.assertEqual(anchor, "com.apple/zzzz_calledit_" + RUN.replace("-", "").lower())
        self.assertIn("from 10.0.0.2 port 50001 to 203.0.113.7 port 443 flags any no state", rules)
        self.assertTrue(rules.endswith('block drop quick all label "zzzz_calledit_' + RUN.replace('-', '').lower() + '_deny"\n'))
        self.assertIn("pass in quick inet proto tcp from 203.0.113.7 port 443 to 10.0.0.2 port 50001 flags any no state", rules)
        self.assertNotIn("user ", rules)
        self.assertIn("proto udp to 198.51.100.77 port 65432", rules)
        self.assertNotIn("keep state", rules)
        with self.assertRaises(firewall.IsolationUnproven):
            firewall.plan_rules(RUN, [])

    def test_SIM_EGRESS_02_unsupported_root_rules_never_get_replaced(self):
        firewall.root_anchor_supported('anchor "com.apple/*" all\n')
        for rules in ('pass out quick all\nanchor "com.apple/*" all\n', 'block all\n', ''):
            with self.assertRaises(firewall.IsolationUnproven):
                firewall.root_anchor_supported(rules)

    def test_SIM_EGRESS_03_kernel_counter_delta_not_timeout_is_denial_proof(self):
        name = "zzzz_calledit_" + RUN.replace("-", "").lower() + "_deny"
        def counters(count):
            return f'block drop out quick on ! lo0 all label "{name}"\n  [ Evaluations: 9 Packets: {count} Bytes: 500 States: 0 ]\n'
        self.assertEqual(firewall.denial_delta(counters(2), counters(3), RUN), 1)
        for after in (counters(2), counters(1), "NXDOMAIN", "no route", "request timed out"):
            with self.assertRaises(firewall.IsolationUnproven):
                firewall.denial_delta(counters(2), after, RUN)

    def test_SIM_EGRESS_04_existing_resolver_or_unknown_states_block_without_flushing(self):
        flows = self.unit_flows()
        firewall.require_no_unowned_states("", flows)
        firewall.require_no_unowned_states("all tcp 10.0.0.2:50001 -> 203.0.113.7:443 ESTABLISHED:ESTABLISHED\n", flows)
        for states in ("all udp 10.0.0.2:53001 -> 192.0.2.53:53 MULTIPLE:MULTIPLE", "all tcp 10.0.0.2:51000 -> 198.51.100.4:443 ESTABLISHED:ESTABLISHED"):
            with self.assertRaises(firewall.IsolationUnproven):
                firewall.require_no_unowned_states(states, flows)

    def test_SIM_EGRESS_05_controller_must_be_observed_established_and_not_a_listener(self):
        for raw in ("", "p91\nu501\nf1u\nPTCP\nn*:443\nTST=LISTEN\n", "p92\nu501\nf1u\nPTCP\nn10.0.0.2:50001->203.0.113.7:443\nTST=ESTABLISHED\n"):
            with self.assertRaises(firewall.IsolationUnproven):
                firewall.controller_flows(raw, [91])

    def test_SIM_EGRESS_06_ipv6_control_tuple_is_numeric_and_exact(self):
        flows = firewall.controller_flows("p91\nu501\nf1u\nPTCP\nTST=ESTABLISHED\nn[2001:db8::1]:50001->[2001:db8::2]:443\n", [91])
        _, rules = firewall.plan_rules(RUN, flows)
        self.assertIn("inet6 proto tcp from 2001:db8::1 port 50001 to 2001:db8::2 port 443", rules)
        for value in ("example.com:443", "[::]:443", "10.0.0.2:0", "10.0.0.2:65536"):
            with self.assertRaises((firewall.IsolationUnproven, ValueError)):
                firewall.endpoint(value)

    def test_SIM_GUARD_05_missing_admin_privilege_blocks_without_rule_write(self):
        calls = []
        def execute(argv, **_kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 1, b"", b"UNIT missing sudo privilege")
        instance = p.Provisioner(unit_request(), self.folder / "output", execute=execute)
        with patch.object(p.platform, "system", return_value="Darwin"), self.assertRaises(p.Blocked):
            instance.preflight()
        self.assertFalse(any("pfctl" in argument for call in calls for argument in call))

    def test_SIM_GUARD_06_linux_cannot_publish_manifest_or_receipt(self):
        instance = p.Provisioner(unit_request(), self.folder / "blocked")
        with patch.object(p.platform, "system", return_value="Linux"), self.assertRaises(p.Blocked):
            instance.inspect()
        self.assertTrue((instance.output / "blocked.json").exists())
        self.assertFalse((instance.output / "receipt.json").exists())
        self.assertFalse((instance.output / "manifest.json").exists())

    def test_SIM_CLEANUP_01_only_owned_uuid_is_removed(self):
        instance = p.Provisioner(unit_request(), self.folder / "cleanup")
        instance.udid = SIMULATOR
        calls = []
        instance.simctl = lambda *argv, **_kwargs: calls.append(argv)
        instance.cleanup()
        self.assertEqual(calls, [("shutdown", SIMULATOR), ("delete", SIMULATOR)])
        self.assertNotIn("all", str(calls))

    def test_SIM_GUARD_07_children_inherit_only_explicit_nonsecret_environment(self):
        with patch.dict(os.environ, {"CONVEX_DEPLOY_KEY": "UNIT-NOT-A-SECRET", "TWILIO_AUTH_TOKEN": "UNIT-NOT-A-SECRET"}):
            environment = p.clean_environment(self.folder, self.folder)
        self.assertEqual(set(environment), {"PATH", "HOME", "TMPDIR", "LANG"})

    def test_SIM_UI_01_generated_xctestrun_selects_only_driver_without_editing_original(self):
        original = {"TestConfigurations": [{"TestTargets": [{"BlueprintName": "CalledItUITests", "IsUITestBundle": True,
                    "TestBundlePath": "__TESTROOT__/UITests.xctest", "EnvironmentVariables": {"OLD": "value"}}]}]}
        raw = plistlib.dumps(original)
        rewritten = plistlib.loads(drive.prepare_test_run(raw, self.folder, RUN, SIMULATOR, b"UNIT NOT NATIVE PROOF", "+12025550101"))
        target = rewritten["TestConfigurations"][0]["TestTargets"][0]
        self.assertEqual(target["OnlyTestIdentifiers"], [drive.METHOD.split("/", 1)[1]])
        self.assertEqual(target["EnvironmentVariables"]["CALLED_IT_PROVISIONER_SIMULATOR_UDID"], SIMULATOR)
        self.assertEqual(target["TestBundlePath"], str(self.folder / "UITests.xctest"))
        self.assertEqual(raw, plistlib.dumps(original))

    def test_SIM_UI_02_missing_actual_ui_target_and_inherited_credentials_block(self):
        for target in ({"BlueprintName": "FakeMessages", "IsUITestBundle": True},
                       {"BlueprintName": "CalledItUITests", "IsUITestBundle": True, "EnvironmentVariables": {"ADMIN_TOKEN": "UNIT"}}):
            with self.assertRaises(p.Blocked):
                drive.prepare_test_run(plistlib.dumps({"target": target}), self.folder, RUN, SIMULATOR, b"UNIT NOT NATIVE PROOF", "+12025550101")

    def test_SIM_EGRESS_07_dns_filter_matches_only_complete_owned_nonce_and_case_folds(self):
        expression = netprobe.dns_filter("a" * 32)
        self.assertIn("udp dst port 53", expression)
        self.assertIn("udp[20] = 32", expression)
        self.assertEqual(expression.count("0xdfdfdfdf"), 8)
        with self.assertRaises(p.Blocked):
            netprobe.dns_filter("anything or ip")

    def test_SIM_EGRESS_08_no_route_or_eperm_without_matching_kernel_counter_is_unproven(self):
        probe = netprobe.NetworkProbe(self.folder, RUN)
        class FakeSocket:
            def __enter__(self): return self
            def __exit__(self, *_args): pass
            def settimeout(self, _value): pass
            def connect(self, _target): raise OSError(self.error, "UNIT OS error alone is not denial proof")
        label = "zzzz_calledit_" + RUN.replace("-", "").lower() + "_probe_tcp4"
        counters = f'block drop out label "{label}"\n [ Evaluations: 10 Packets: 0 Bytes: 0 ]\n'
        for code in (1, 13, 101, 110):
            fake = FakeSocket()
            fake.error = code
            with self.subTest(errno=code), patch.object(netprobe.socket, "socket", return_value=fake), patch.object(probe, "counters", return_value=counters), self.assertRaisesRegex(p.Blocked, "no attributable kernel"):
                probe.raw_denials()

    def test_SIM_EGRESS_09_nested_filter_or_translation_quick_paths_are_not_trusted(self):
        empty = 'anchor "com.apple/*" all {\n anchor "250.ApplicationFirewall" all {\n }\n}\n'
        firewall.reject_unreviewed_tree(empty)
        for rule in ('pass out quick all', 'block in all', 'anchor "foreign" quick', 'rdr on en0 to any -> 127.0.0.1'):
            with self.subTest(rule=rule), self.assertRaises(firewall.IsolationUnproven):
                firewall.reject_unreviewed_tree(empty.replace(' }', ' ' + rule + '\n }'))

    def unit_lease(self):
        instance = object.__new__(lease.Lease)
        instance.folder_verified = True
        instance.uid = os.getuid()
        instance.groups = {}
        instance.device = None
        instance.enable_attempted = True
        instance.token = "12345"
        instance.anchor = "com.apple/zzzz_calledit_" + RUN.replace("-", "").lower()
        instance.owns_anchor = True
        instance.owns_pflog = False
        instance.reason = "UNIT FABRICATED, NO ACTUAL PF OR SIMULATOR"
        instance.run_id = RUN
        instance.audit = []
        instance.home = self.folder
        instance.folder = self.folder
        instance.owner_pid = 99
        instance.parent_identity = {"uid": os.getuid(), "birth": "UNIT original"}
        instance.seconds = 30
        instance.root = 'anchor "com.apple/*" all\n'
        instance.rules = "UNIT ACTIVE OWNED RULES"
        instance.baseline_filter_tree = instance.root
        instance.active_filter_tree = 'anchor "com.apple/*" all {\n anchor "' + instance.anchor.split('/')[-1] + '" all {\n ' + instance.rules + '\n }\n}\n'
        instance.baseline_translation_tree = ""
        instance.anchor_inventory = instance.anchor.split('/')[-1] + "\n"
        instance.control = None
        instance.initial_pflog_exists = False
        instance.initial_anchor_inventory = ""
        instance.baseline_processes = {}
        instance.descendants = {}
        instance.escaped = {}
        instance.snapshot = Mock(return_value={})
        instance.command = Mock(return_value="")
        active = [True]
        rules_active = [True]
        def pf(*argv):
            if argv == ("-s", "info"):
                return "Status: Enabled\n" if active[0] else "Status: Disabled\n"
            if "-X" in argv:
                active[0] = False
            if "-F" in argv:
                rules_active[0] = False
            if argv == ("-a", instance.anchor, "-sr"):
                return instance.rules if rules_active[0] else ""
            if argv == ("-a", "*", "-sr"):
                return instance.active_filter_tree if rules_active[0] else instance.root
            if argv == ("-a", "com.apple", "-s", "Anchors"):
                return instance.anchor_inventory if rules_active[0] else instance.initial_anchor_inventory
            if argv == ("-sr",):
                return instance.root
            return ""
        instance.pf = Mock(side_effect=pf)
        instance.record = Mock()
        return instance

    def test_SIM_LEASE_01_cleanup_releases_only_owned_anchor_and_enable_token(self):
        instance = self.unit_lease()
        with patch.object(lease.time, "sleep"):
            instance.cleanup()
        mutations = [call.args for call in instance.pf.call_args_list if "-F" in call.args or "-X" in call.args]
        self.assertEqual(mutations, [("-a", instance.anchor, "-F", "rules"), ("-X", "12345")])
        recorded = instance.record.call_args.args[1]
        self.assertFalse(recorded["isolationRetained"])
        self.assertNotIn("states", str(instance.pf.call_args_list))
        self.assertNotIn("-d", str(instance.pf.call_args_list))
        self.assertIn("Status: Disabled", recorded["restoration"]["actualPFInfoAfterRelease"])
        self.assertFalse(recorded["restoration"]["pflogPresentAfterCleanup"])

    def test_SIM_LEASE_02_unproven_device_stop_retains_firewall_instead_of_false_restore(self):
        instance = self.unit_lease()
        instance.device = SIMULATOR
        instance.command = Mock(side_effect=RuntimeError("UNIT shutdown failure"))
        with patch.object(lease.time, "sleep"), self.assertRaisesRegex(p.Blocked, "retained isolation"):
            instance.cleanup()
        self.assertFalse(any("-F" in call.args or "-X" in call.args for call in instance.pf.call_args_list))
        self.assertTrue(instance.record.call_args.args[1]["failures"])

    def test_SIM_LEASE_03_orphaned_owned_group_is_stopped_even_after_leader_exits(self):
        instance = self.unit_lease()
        instance.groups = {535: {"uid": os.getuid(), "pgid": 535, "birth": "UNIT old"}}
        alive = [True]
        instance.snapshot = Mock(side_effect=lambda: {536: {"uid": os.getuid(), "ppid": 1, "pgid": 535, "birth": "UNIT child", "state": "S", "command": "UNIT worker"}} if alive[0] else {})
        def stop(_pid, _signal):
            alive[0] = False
        with patch.object(lease.time, "sleep"), patch.object(lease.os, "getsid", return_value=535), patch.object(lease.os, "killpg", side_effect=stop) as kill:
            instance.cleanup()
        kill.assert_called_once_with(535, lease.signal.SIGTERM)

    def test_SIM_LEASE_04_parent_identity_change_always_enters_independent_cleanup(self):
        instance = self.unit_lease()
        instance.prepare = Mock()
        instance.cleanup = Mock()
        with patch.object(lease.time, "monotonic", side_effect=[0, 1]), patch.object(lease, "identity", return_value={"uid": os.getuid(), "birth": "UNIT reused"}), self.assertRaisesRegex(p.Blocked, "reused PID"):
            instance.run()
        instance.cleanup.assert_called_once()

    def test_SIM_LEASE_05_bounded_expiry_always_enters_independent_cleanup(self):
        instance = self.unit_lease()
        instance.prepare = Mock()
        instance.cleanup = Mock()
        with patch.object(lease.time, "monotonic", side_effect=[0, 31]), self.assertRaisesRegex(RuntimeError, "bounded lease expired"):
            instance.run()
        instance.cleanup.assert_called_once()

    def test_SIM_LEASE_06_failed_identity_observation_never_grants_kill_permission(self):
        instance = self.unit_lease()
        instance.groups = {535: {"uid": os.getuid(), "pgid": 535, "birth": "UNIT old"}}
        instance.snapshot = Mock(side_effect=RuntimeError("UNIT observation unavailable, not ESRCH"))
        with patch.object(lease.time, "sleep"), patch.object(lease.os, "killpg") as kill, self.assertRaises(p.Blocked):
            instance.cleanup()
        kill.assert_not_called()
        self.assertFalse(any("-F" in call.args or "-X" in call.args for call in instance.pf.call_args_list))

    def test_SIM_LEASE_07_escaped_descendant_survivor_prevents_firewall_release(self):
        instance = self.unit_lease()
        instance.groups = {535: {"uid": os.getuid(), "pgid": 535, "birth": "UNIT old"}}
        alive = [True]
        parent = {"uid": os.getuid(), "ppid": 99, "pgid": 535, "birth": "UNIT old", "state": "S", "command": "UNIT supervised"}
        child = {"uid": os.getuid(), "ppid": 535, "pgid": 536, "birth": "UNIT escaped", "state": "S", "command": "UNIT detached"}
        instance.snapshot = Mock(side_effect=lambda: {**({535: parent} if alive[0] else {}), 536: child})
        def stop(_pid, _signal): alive[0] = False
        with patch.object(lease.time, "sleep"), patch.object(lease.os, "getsid", side_effect=lambda pid: pid), patch.object(lease.os, "killpg", side_effect=stop) as kill, self.assertRaises(p.Blocked):
            instance.cleanup()
        self.assertTrue(all(call.args[0] == 535 for call in kill.call_args_list))
        self.assertFalse(any("-F" in call.args or "-X" in call.args for call in instance.pf.call_args_list))
        self.assertIn(536, instance.record.call_args.args[1]["restoration"]["survivingOwnedOrEscapedProcesses"])

    def test_SIM_LEASE_08_successful_release_command_without_restored_kernel_baseline_fails(self):
        instance = self.unit_lease()
        previous = instance.pf.side_effect
        instance.pf.side_effect = lambda *argv: "Status: Enabled\n" if argv == ("-s", "info") else previous(*argv)
        with patch.object(lease.time, "sleep"), self.assertRaises(p.Blocked):
            instance.cleanup()
        record = instance.record.call_args.args[1]
        self.assertIn("Status: Enabled", record["restoration"]["actualPFInfoAfterRelease"])
        self.assertTrue(record["failures"])
        self.assertNotIn("-d", str(instance.pf.call_args_list))

    def test_SIM_LEASE_09_changed_active_policy_or_states_prevents_any_release(self):
        for target, value in ((("-sr",), "UNIT changed root"), (("-a", "*", "-sr"), "UNIT unknown quick path"),
                              (("-a", "*", "-sn"), "UNIT unknown translation"), (("-ss",), "UNIT unexpected state"),
                              (("-a", "com.apple", "-s", "Anchors"), "UNIT changed order")):
            instance = self.unit_lease()
            previous = instance.pf.side_effect
            instance.pf.side_effect = lambda *args: value if args == target else previous(*args)
            with patch.object(lease.time, "sleep"), self.assertRaises(p.Blocked):
                instance.cleanup()
            self.assertFalse(any("-F" in call.args or "-X" in call.args for call in instance.pf.call_args_list))
            record = instance.record.call_args.args[1]
            self.assertNotIn("enforcementReleaseStartedAt", record)
            self.assertIsNone(record["isolationRetained"])

    def test_SIM_LEASE_10_partial_enable_never_accesses_unknown_active_baseline_or_releases(self):
        instance = self.unit_lease()
        instance.rules = instance.active_filter_tree = instance.anchor_inventory = None
        instance.token = None
        with patch.object(lease.time, "sleep"), self.assertRaises(p.Blocked):
            instance.cleanup()
        self.assertFalse(any("-F" in call.args or "-X" in call.args for call in instance.pf.call_args_list))
        record = instance.record.call_args.args[1]
        self.assertNotIn("enforcementReleaseStartedAt", record)
        self.assertIn("recordedAt", record)

    def test_SIM_LEASE_11_release_bound_follows_final_policy_check_and_precedes_owned_removal(self):
        instance = self.unit_lease()
        with patch.object(lease.time, "sleep"):
            instance.cleanup()
        record = instance.record.call_args.args[1]
        self.assertLessEqual(record["enforcementReleaseStartedAt"], record["recordedAt"])
        self.assertIn("beforeReleaseRootRules", record["restoration"])
        self.assertIn("translationTreeAfterRelease", record["restoration"])
        self.assertFalse(record["isolationRetained"])

    def test_SIM_LEASE_12_uncertain_pflog_create_is_never_adopted_or_destroyed(self):
        instance = self.unit_lease()
        instance.owns_anchor = instance.enable_attempted = False
        instance.token = None
        instance.pflog_create_attempted = True
        with patch.object(lease.time, "sleep"), self.assertRaises(p.Blocked):
            instance.cleanup()
        self.assertFalse(any("destroy" in call.args[0] for call in instance.command.call_args_list))
        self.assertNotIn("enforcementReleaseStartedAt", instance.record.call_args.args[1])

    def test_SIM_LEASE_13_failed_management_liveness_restores_owned_policy_but_never_passes_run(self):
        instance = self.unit_lease()
        instance.control = Mock()
        instance.control_audit = []
        instance.check_control = Mock(side_effect=p.Blocked("UNIT stale operator pulse"))
        with patch.object(lease.time, "sleep"), self.assertRaisesRegex(p.Blocked, "run failed"):
            instance.cleanup()
        record = instance.record.call_args.args[1]
        self.assertFalse(record["isolationRetained"])
        self.assertEqual(record["resourceRestorationFailures"], [])
        self.assertTrue(record["runEvidenceFailures"])
        self.assertTrue(record["failures"])
        self.assertIn("enforcementReleaseStartedAt", record)
        self.assertTrue(any("-F" in call.args for call in instance.pf.call_args_list))

    def test_SIM_LEASE_14_foreign_postload_insertions_never_become_blessed_baseline(self):
        instance = self.unit_lease()
        instance.pf = Mock(side_effect=lambda *args: instance.root if args == ("-sr",) else
                           instance.rules if args == ("-a", instance.anchor, "-sr") else
                           instance.active_filter_tree.replace("\n}", '\n anchor "foreign" all {\n pass out quick all\n }\n}') if args == ("-a", "*", "-sr") else
                           instance.anchor_inventory if args == ("-a", "com.apple", "-s", "Anchors") else
                           "Status: Disabled\n" if args == ("-s", "info") else "")
        with self.assertRaises(firewall.IsolationUnproven):
            instance.verify_owned_insertion(enabled=False)

    def test_SIM_AUTH_01_generic_entry_cannot_start_an_isolation_lease(self):
        instance = p.Provisioner(unit_request(), self.folder / "untrusted-generic")
        instance.start_lease = Mock()
        instance.preflight = Mock()
        with self.assertRaisesRegex(p.Blocked, "trusted parent"):
            instance.run(enforcement_probe=True)
        instance.start_lease.assert_not_called()
        instance.preflight.assert_not_called()

    def test_SIM_AUTH_02_root_preparation_checks_launch_authority_before_any_pf_query_or_mutation(self):
        instance = self.unit_lease()
        instance.launch_context = str(self.folder / "UNIT-unbound.json")
        instance.launch_sha256 = "0" * 64
        with patch.object(lease, "verify_trusted_launch", side_effect=p.Blocked("UNIT unbound launch")), self.assertRaises(p.Blocked):
            instance.prepare()
        instance.pf.assert_not_called()
        instance.command.assert_not_called()

    def test_SIM_AUTH_03_supplied_exclusivity_booleans_are_not_authority(self):
        path = self.folder / "UNIT-fabricated-claim.json"
        path.write_text(json.dumps({"dedicated": True, "ephemeral": True, "exclusive": True}))
        with patch.object(launch_provenance.subprocess, "run") as query, self.assertRaises(p.Blocked):
            launch_provenance.verify_trusted_launch(str(path), p.digest(path.read_bytes()), RUN)
        query.assert_not_called()

    def launch_fixture(self):
        root = self.folder / "UNIT-FABRICATED-ARCHIVE"
        harness = root / "tests/simulator-provisioner"
        harness.mkdir(parents=True)
        for pattern in ("*.py", "*.ts"):
            for source in HERE.glob(pattern):
                shutil.copyfile(source, harness / source.name)
        shutil.copyfile(HERE / "vsock-profile.json", harness / "vsock-profile.json")
        (root / "tests/mac-enforcement").mkdir()
        shutil.copyfile(HERE.parent / "mac-enforcement/control-sockets.c", root / vsock_control.SOURCE_NAME)
        config = root / "UNIT-config.json"
        config.write_text(json.dumps({"classification": "UNIT ONLY, NOT ACTUAL LAUNCH OR ISOLATION EVIDENCE"}))
        nonce = "77777777-8888-4999-AAAA-BBBBBBBBBBBB"
        provider = "UNIT ONLY: Every remote build runs in a clean, single-use VM. Concurrent builds work in private VMs.\n"
        provider_hash = p.digest(provider.encode())
        authority = {"kind": "reviewed-provider-guarantee-and-trusted-tool-route",
                     "source": {"url": launch_provenance.REVYL_URL, "readableContentSHA256": provider_hash, "snapshot": provider},
                     "toolRoute": {"documentation": launch_provenance.CAPY_URL, "sourceKind": "workspace",
                                   "authority": "UNIT mobile.build", "execution": "UNIT Revyl remote build commands"}}
        files = {str(file.relative_to(root)): p.digest(file.read_bytes()) for file in harness.iterdir()}
        files[vsock_control.SOURCE_NAME] = vsock_control.SOURCE_SHA256
        files[config.name] = p.digest(config.read_bytes())
        manifest = {"version": 2, "runID": RUN, "launchNonce": nonce, "files": files,
                    "configurationFiles": {config.name: files[config.name], "tests/simulator-provisioner/vsock-profile.json": files["tests/simulator-provisioner/vsock-profile.json"]}}
        manifest_path = root / "UNIT-source-manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        now = int(p.time.time() * 1000)
        plan = {"version": 2, "kind": "trusted-parent-prelaunch-plan", "runID": RUN, "launchNonce": nonce,
                "sourceManifestSHA256": p.digest(manifest_path.read_bytes()), "issuedAt": now - 1000, "expiresAt": now + 600_000,
                "scope": dict(launch_provenance.AUTHORITY_SCOPE)}
        context = {"version": 2, "runID": RUN, "launchNonce": nonce}
        for key, value in (("reviewedAuthority", authority), ("sourceManifest", manifest), ("launchPlan", plan)):
            artifact = root / ("UNIT-" + key + ".json")
            artifact.write_text(json.dumps(value))
            context[key] = {"file": artifact.name, "sha256": p.digest(artifact.read_bytes())}
        path = root / "UNIT-context.json"
        path.write_text(json.dumps(context))
        return {"root": root, "harness": harness, "config": config, "context": context, "path": path,
                "plan": plan, "manifest": manifest, "providerHash": provider_hash, "ledger": root / "UNIT-root-ledger"}

    def rewrite_launch(self, fixture, key, value):
        artifact = fixture["root"] / fixture["context"][key]["file"]
        artifact.write_text(json.dumps(value))
        fixture["context"][key]["sha256"] = p.digest(artifact.read_bytes())
        fixture["path"].write_text(json.dumps(fixture["context"]))

    @contextlib.contextmanager
    def launch_environment(self, fixture, boot=SIMULATOR, root=True):
        original_stat = Path.stat
        def unit_stat(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if path == fixture["ledger"] or path.parent == fixture["ledger"]:
                values = list(info)
                values[4] = 0
                return os.stat_result(values)
            return info
        def query(argv, **_kwargs):
            if argv == ["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]:
                return subprocess.CompletedProcess(argv, 0, (boot + "\n").encode(), b"")
            self.assertEqual(argv, ["/bin/ps", "-p", str(os.getpid()), "-o", "lstart="])
            return subprocess.CompletedProcess(argv, 0, b"UNIT FABRICATED root process birth\n", b"")
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(launch_provenance, "__file__", str(fixture["harness"] / "launch_provenance.py")))
            stack.enter_context(patch.object(vsock_control, "__file__", str(fixture["harness"] / "vsock_control.py")))
            stack.enter_context(patch.object(root_capsule, "__file__", str(fixture["harness"] / "root_capsule.py")))
            stack.enter_context(patch.object(launch_provenance, "REVIEWED_READABLE_SHA256", fixture["providerHash"]))
            stack.enter_context(patch.object(launch_provenance, "NONCE_DIRECTORY", fixture["ledger"]))
            stack.enter_context(patch.object(launch_provenance.platform, "system", return_value="Darwin"))
            stack.enter_context(patch.object(launch_provenance.os, "geteuid", return_value=0 if root else 501))
            stack.enter_context(patch.object(Path, "stat", unit_stat))
            query_mock = stack.enter_context(patch.object(launch_provenance.subprocess, "run", side_effect=query))
            yield query_mock

    def verify_launch(self, fixture, consume=False):
        return launch_provenance.verify_trusted_launch(str(fixture["path"]), p.digest(fixture["path"].read_bytes()), RUN, consume)

    def test_SIM_AUTH_04_prelaunch_seal_uses_observed_boot_without_future_job_or_boot_fields(self):
        fixture = self.launch_fixture()
        with self.launch_environment(fixture) as query:
            result = self.verify_launch(fixture)
        self.assertEqual(result["guestBootSessionUUID"], SIMULATOR)
        self.assertEqual(result["launchNonce"], fixture["context"]["launchNonce"])
        self.assertEqual(result["configurationSHA256"], launch_provenance.sealed_digest(fixture["manifest"]["configurationFiles"]))
        self.assertEqual(result["guardSHA256"], launch_provenance.sealed_digest({name: fixture["manifest"]["files"][name] for name in launch_provenance.REQUIRED}))
        self.assertEqual(query.call_count, 1)
        self.assertFalse(fixture["ledger"].exists())
        for forbidden in ("buildID", "build_id", "operationID", "bootSessionUUID", "result", "invocation"):
            self.assertNotIn(forbidden, fixture["plan"])
            self.assertNotIn(forbidden, result)

    def test_SIM_AUTH_05_future_or_legacy_job_and_boot_claims_are_rejected(self):
        fixture = self.launch_fixture()
        for key in ("buildID", "bootSessionUUID", "result", "invocation"):
            self.rewrite_launch(fixture, "launchPlan", {**fixture["plan"], key: "UNIT INVENTED FUTURE VALUE"})
            with self.launch_environment(fixture) as query, self.assertRaises(p.Blocked):
                self.verify_launch(fixture)
            query.assert_not_called()
        self.rewrite_launch(fixture, "launchPlan", fixture["plan"])
        fixture["context"]["version"] = 1
        fixture["path"].write_text(json.dumps(fixture["context"]))
        with self.launch_environment(fixture), self.assertRaises(p.Blocked):
            self.verify_launch(fixture)

    def test_SIM_GUARD_08_preflight_observes_only_explicit_controller_pids_with_bounded_sudo(self):
        instance = p.Provisioner(unit_request(), self.folder / "UNIT-preflight")
        def command(argv, **kwargs):
            if argv == ["/usr/bin/sudo", "-n", "/usr/bin/id", "-u"]:
                return "0\n"
            if argv == ["/usr/bin/sudo", "-n", "/sbin/pfctl", "-sr"]:
                return 'anchor "com.apple/*" all\n'
            if "/usr/sbin/lsof" in argv:
                self.assertEqual(argv, ["/usr/bin/sudo", "-n", "/usr/sbin/lsof", "-nP", "-a", "-p", "91", "-iTCP", "-sTCP:ESTABLISHED", "-FpcuftPnT"])
                self.assertEqual(kwargs, {"timeout": 10})
                return "p91\nccontroller\nu0\nf12u\nPTCP\nn10.0.0.2:50001->203.0.113.7:443\nTST=ESTABLISHED\n"
            return ""
        instance.command = Mock(side_effect=command)
        with patch.object(p.platform, "system", return_value="Darwin"):
            instance.preflight()
        self.assertTrue(any("/usr/sbin/lsof" in call.args[0] for call in instance.command.call_args_list))
        self.assertFalse(any("-F" in call.args[0] or "-E" in call.args[0] for call in instance.command.call_args_list))

    def test_SIM_AUTH_06_generic_shared_or_boolean_scope_never_authorizes_boot_or_pf_query(self):
        fixture = self.launch_fixture()
        for scope in ({**launch_provenance.AUTHORITY_SCOPE, "source": "local"}, {**launch_provenance.AUTHORITY_SCOPE, "guest": "shared"},
                      {"exclusive": True, "dedicated": True, "ephemeral": True}, {**launch_provenance.AUTHORITY_SCOPE, "cache": "runtime-state"}):
            self.rewrite_launch(fixture, "launchPlan", {**fixture["plan"], "scope": scope})
            with self.launch_environment(fixture) as query, self.assertRaises(p.Blocked):
                self.verify_launch(fixture)
            query.assert_not_called()

    def test_SIM_AUTH_07_nonce_source_configuration_and_plan_freshness_are_sealed(self):
        fixture = self.launch_fixture()
        for plan in ({**fixture["plan"], "launchNonce": RUN}, {**fixture["plan"], "sourceManifestSHA256": "0" * 64},
                     {**fixture["plan"], "expiresAt": 1}):
            self.rewrite_launch(fixture, "launchPlan", plan)
            with self.launch_environment(fixture) as query, self.assertRaises(p.Blocked):
                self.verify_launch(fixture)
            query.assert_not_called()
        self.rewrite_launch(fixture, "launchPlan", fixture["plan"])
        for path in (fixture["config"], fixture["harness"] / "lease.py"):
            original = path.read_bytes()
            path.write_bytes(original + b"\nUNIT MUTATION\n")
            with self.launch_environment(fixture) as query, self.assertRaises(p.Blocked):
                self.verify_launch(fixture)
            query.assert_not_called()
            path.write_bytes(original)

    def test_SIM_AUTH_08_root_records_full_current_chain_once_before_any_pf_command(self):
        fixture = self.launch_fixture()
        instance = self.unit_lease()
        instance.launch_context = str(fixture["path"])
        instance.launch_sha256 = p.digest(fixture["path"].read_bytes())
        with self.launch_environment(fixture), self.assertRaises(FileNotFoundError):
            instance.prepare()
        instance.pf.assert_not_called()
        instance.command.assert_not_called()
        name, authorization = instance.record.call_args.args
        self.assertEqual(name, "runner-authorized.json")
        with self.launch_environment(fixture):
            witness, _ = launch_provenance.root_launch_witness(authorization, os.getpid())
            self.assertEqual(witness["chain"]["guestBootSessionUUID"], SIMULATOR)
            self.assertEqual(witness["chainSHA256"], authorization["chainSHA256"])
            with self.assertRaises(FileExistsError):
                self.verify_launch(fixture, consume=True)

    def test_SIM_AUTH_09_old_boot_or_other_root_process_cannot_reuse_consumption_witness(self):
        fixture = self.launch_fixture()
        with self.launch_environment(fixture):
            authorization = self.verify_launch(fixture, consume=True)
            with self.assertRaises(p.Blocked):
                launch_provenance.root_launch_witness(authorization, os.getpid() + 1)
        with self.launch_environment(fixture, boot="BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF"), self.assertRaises(p.Blocked):
            self.verify_launch(fixture)
        marker = fixture["ledger"] / (fixture["context"]["launchNonce"] + ".json")
        marker.chmod(0o644)
        with self.launch_environment(fixture), self.assertRaises(p.Blocked):
            self.verify_launch(fixture)

    def test_SIM_AUTH_10_nonroot_cannot_consume_and_missing_harness_or_config_seal_is_rejected(self):
        fixture = self.launch_fixture()
        with self.launch_environment(fixture, root=False), self.assertRaises(p.Blocked):
            self.verify_launch(fixture, consume=True)
        self.assertFalse(fixture["ledger"].exists())
        for manifest in ({**fixture["manifest"], "configurationFiles": {}},
                         {**fixture["manifest"], "files": {key: value for key, value in fixture["manifest"]["files"].items() if not key.endswith("test_provisioner.py")}}):
            self.rewrite_launch(fixture, "sourceManifest", manifest)
            self.rewrite_launch(fixture, "launchPlan", {**fixture["plan"], "sourceManifestSHA256": fixture["context"]["sourceManifest"]["sha256"]})
            with self.launch_environment(fixture) as query, self.assertRaises(p.Blocked):
                self.verify_launch(fixture)
            query.assert_not_called()

    def live_status_fixture(self):
        now = int(p.time.time() * 1000)
        authority = {"chainSHA256": "a" * 64, "launchNonce": "77777777-8888-4999-AAAA-BBBBBBBBBBBB",
                     "contextSHA256": "b" * 64,
                     "guestBootSessionUUID": SIMULATOR, "classification": "UNIT FABRICATED STATUS INPUT"}
        ready = {"runID": RUN, "ownerPID": 91, "leasePID": 535, "leaseIdentity": {"birth": "UNIT root birth"},
                 "leaseExpiresAt": now + 60_000, "recordedAt": now - 100,
                 "launchContext": str(self.folder / "UNIT-launch.json"), "launchContextSHA256": "b" * 64,
                 "runnerAuthorization": authority, "rootRules": "UNIT root rules", "activeRules": "UNIT active rules",
                 "activeFilterTree": "UNIT filter tree", "baselineTranslationTree": "UNIT translation tree",
                 "anchor": "com.apple/zzzz_calledit_" + RUN.replace("-", "").lower()}
        witness = {"rootGuard": {"pid": 535, "uid": 0, "birth": "UNIT root birth"}, "consumedAt": now - 200}
        capsule = "/private/var/run/calledit-qa-capsules/" + authority["launchNonce"]
        capsule_raw = json.dumps({"contextSHA256": ready["launchContextSHA256"]})
        witness["rootGuard"].update({"capsuleDirectory": capsule, "capsuleInfoSHA256": p.digest(capsule_raw.encode())})
        ready["leaseProgram"] = capsule + "/tests/simulator-provisioner/lease.py"
        ready["rootAuthorityContextPath"] = capsule + "/root-authority/context.json"
        ready["controlRuntimeSHA256"] = "d" * 64
        capture = b"UNIT FABRICATED PCAP; NO ACTUAL KERNEL OR MAC EVIDENCE"
        proof = {"runID": RUN, "verifiedAt": now, "resolverBroker": {"pcapFile": "resolver-blocked.pcap",
                 "pcapSHA256": p.digest(capture), "hostname": "unit-fabricated.example.com"}}
        proof["controller"] = {"rootControlWitnessSHA256": ready["controlRuntimeSHA256"]}
        for name, value in (("lease-ready.json", ready), ("heartbeat.json", {"runID": RUN}), ("network-verified.json", proof)):
            (self.folder / name).write_text(json.dumps(value))
        (self.folder / "resolver-blocked.pcap").write_bytes(capture)
        outputs = {("/bin/ps", "-p", "535", "-o", "uid="): "0\n",
                   ("/bin/ps", "-p", "91", "-o", "uid="): "501\n",
                   ("/bin/ps", "-p", "535", "-o", "lstart="): "UNIT root birth\n",
                   ("/usr/bin/sudo", "-n", "/bin/ps", "-p", "535", "-o", "args="):
                       "UNIT " + ready["leaseProgram"] + " " + str(self.folder) + " " + RUN,
                   ("/usr/bin/sudo", "-n", "/bin/cat", capsule + "/capsule-info.json"): capsule_raw}
        for args, value in ((("-sr",), ready["rootRules"]), (("-a", ready["anchor"], "-sr"), ready["activeRules"]),
                            (("-a", "*", "-sr"), ready["activeFilterTree"]), (("-a", "*", "-sn"), ready["baselineTranslationTree"]),
                            (("-s", "info"), "Status: Enabled\n"), (("-ss",), "")):
            outputs[("/usr/bin/sudo", "-n", "/sbin/pfctl", *args)] = value
        outputs[("/usr/sbin/tcpdump", "-n", "-e", "-vv", "-r", str(self.folder / "resolver-blocked.pcap"))] = "UNIT unit-fabricated.example.com block out"
        return authority, ready, witness, proof, outputs

    @contextlib.contextmanager
    def status_environment(self, authority, witness, outputs):
        capsule_directory = "/private/var/run/calledit-qa-capsules/" + authority["launchNonce"]
        ordinary_regular = p.regular
        def unit_regular(path, *args):
            if str(path) == capsule_directory + "/root-records/lease-ready.json":
                path = str(self.folder / "lease-ready.json")
            return ordinary_regular(path, *args)
        def query(argv, **_kwargs):
            self.assertIn(tuple(argv), outputs)
            return subprocess.CompletedProcess(argv, 0, outputs[tuple(argv)].encode(), b"")
        with patch.object(provisioning_status.platform, "system", return_value="Darwin"), \
                patch.object(provisioning_status, "verify_trusted_launch", return_value=authority) as launch, \
                patch.object(provisioning_status, "root_launch_witness", return_value=(witness, "c" * 64)), \
                patch.object(provisioning_status, "live_control", return_value={"classification": "UNIT MOCK", "ownerUID": 501, "outputDirectory": str(self.folder)}), \
                patch.object(provisioning_status, "capsule_info", return_value={"directory": capsule_directory, "info": {"privateContextPath": capsule_directory + "/root-authority/context.json"}}), \
                patch.object(provisioning_status, "regular", side_effect=unit_regular), \
                patch.object(provisioning_status.os, "geteuid", return_value=0), \
                patch.object(provisioning_status.pwd, "getpwuid", return_value=type("Pw", (), {"pw_dir": str(self.folder)})()), \
                patch.object(provisioning_status.subprocess, "run", side_effect=query), \
                patch.object(provisioning_status, "source_fingerprints", return_value={"classification": "UNIT-FABRICATED"}):
            yield launch

    def test_SIM_STATUS_01_design_mock_rechecks_current_root_nonce_boot_chain_without_job_id(self):
        authority, ready, witness, _proof, outputs = self.live_status_fixture()
        with self.status_environment(authority, witness, outputs) as launch:
            observed = provisioning_status.live_status(self.folder, RUN, 91)
        launch.assert_called_once_with(ready["rootAuthorityContextPath"], ready["launchContextSHA256"], RUN)
        self.assertEqual(observed["runnerAuthorization"], authority)
        self.assertEqual(observed["rootLaunchWitnessSHA256"], "c" * 64)

    def test_SIM_STATUS_02_design_mock_refuses_changed_chain_pid_birth_or_previous_lease_proof(self):
        authority, ready, witness, proof, outputs = self.live_status_fixture()
        for replacement, root in (({**authority, "chainSHA256": "0" * 64}, witness),
                                  (authority, {**witness, "rootGuard": {**witness["rootGuard"], "birth": "UNIT reused PID"}}),
                                  (authority, {**witness, "consumedAt": ready["recordedAt"] + 1})):
            with self.status_environment(replacement, root, outputs), self.assertRaises(p.Blocked):
                provisioning_status.live_status(self.folder, RUN, 91)
        (self.folder / "network-verified.json").write_text(json.dumps({**proof, "verifiedAt": ready["recordedAt"] - 1}))
        with self.status_environment(authority, witness, outputs), self.assertRaisesRegex(p.Blocked, "previous run"):
            provisioning_status.live_status(self.folder, RUN, 91)

    def test_SIM_GATE_01_unapproved_workload_never_executes(self):
        (self.folder / "jobs").mkdir()
        command = self.folder / "unit-argv.json"
        command.write_text(json.dumps([str(Path(sys.executable).resolve()), "-c", "raise SystemExit(0)"]))
        with patch.object(sys, "argv", ["job.py", str(self.folder), str(command)]), patch.object(job.os, "getpid", return_value=535), patch.object(job.os, "getppid", return_value=99), patch.object(job.os, "getpgid", return_value=535), patch.object(job.time, "monotonic", side_effect=[0, 11]), patch.object(job.os, "execve") as execute, self.assertRaisesRegex(RuntimeError, "did not approve"):
            job.main()
        execute.assert_not_called()
        self.assertTrue((self.folder / "jobs/535.json").exists())

    def test_SIM_RECEIPT_01_exact_manifest_and_existing_receipt_hashes_unit_fabricated_only(self):
        instance = p.Provisioner(unit_request(), self.folder)
        instance.udid = SIMULATOR
        instance.lease_ready = {"recordedAt": int(p.time.time() * 1000), "leaseExpiresAt": int(p.time.time() * 1000) + 600_000, "unitOnly": "FABRICATED"}
        instance.network_proof = {"runID": RUN, "verifiedAt": 1, "unitOnly": "FABRICATED"}
        instance.lease_child = Mock()
        instance.lease_child.poll.return_value = None
        instance.boot_started = 2
        instance.builds = {"unitOnly": "FABRICATED"}
        instance.created = instance.erased = instance.empty = {"unitOnly": "FABRICATED, NOT SIMULATOR EVIDENCE"}
        p.write_new(self.folder / "lease-ready.json", instance.lease_ready)
        p.write_new(self.folder / "network-verified.json", instance.network_proof)
        instance.publish()
        receipt = json.loads((self.folder / "receipt.json").read_bytes())
        manifest_bytes = (self.folder / "manifest.json").read_bytes()
        self.assertEqual(set(receipt), {"version", "runID", "simulatorUDID", "nativeSourceRevision", "backendSourceRevision", "fixtureSetID", "hostBundleID", "extensionBundleID", "manifestSHA256", "recordedAt", "artifacts"})
        self.assertEqual(receipt["manifestSHA256"], p.digest(manifest_bytes))
        self.assertEqual({entry["kind"] for entry in receipt["artifacts"]}, {"simulator-created", "simulator-erased", "empty-state-verified", "outbound-denied"})
        for artifact in receipt["artifacts"]:
            data = (self.folder / artifact["file"]).read_bytes()
            self.assertEqual(artifact["sha256"], p.digest(data))
            self.assertIn(b"FABRICATED", data)
        manifest = json.loads(manifest_bytes)
        self.assertEqual(set(manifest), {"version", "runID", "simulatorUDID", "nativeSourceRevision", "backendSourceRevision", "deploymentID", "configVersion", "fixtureSetID", "apiOrigin", "cardOrigin", "issuedAt", "expiresAt", "erasedSimulator", "syntheticDataOnly", "outboundNetworkDenied"})
        self.assertEqual(manifest["apiOrigin"], "http://127.0.0.1:8199")
        self.assertEqual(manifest["cardOrigin"], "http://127.0.0.1:3211")
        self.assertNotIn("sourceCardOrigin", manifest)

    def test_SIM_RECEIPT_02_cleanup_failure_never_writes_completed_record(self):
        instance = p.Provisioner(unit_request(), self.folder)
        instance.lease_child = Mock()
        instance.lease_child.poll.return_value = 1
        instance.pending_completion = {"unitOnly": "must not become completed"}
        p.write_new(self.folder / "lease-cleanup.json", {"failures": ["UNIT retained isolation"]})
        with self.assertRaises(p.Blocked):
            instance.cleanup()
        self.assertFalse((self.folder / "completed.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
