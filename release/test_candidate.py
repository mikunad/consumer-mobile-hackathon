import copy
import datetime as dt
import hashlib
import json
import plistlib
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

import candidate


def config():
    return {
        "source_revision": "a" * 40, "version": "1.0", "build": "17", "build_channel": "release",
        "environment": "staging", "api_url": "https://synthetic-stage.convex.cloud",
        "web_url": "https://synthetic-stage.convex.site", "team_id": "SYNTHETIC1",
        "support_url": "https://support.synthetic.org/help",
        "app_identifier_prefix": "SYNTHETIC1", "host_id": "com.synthetic.calledit",
        "extension_id": "com.synthetic.calledit.ext", "app_group": "group.com.synthetic.calledit",
        "keychain_group": "SYNTHETIC1.com.synthetic.session",
        "signing_certificate_sha1": hashlib.sha1(b"synthetic certificate").hexdigest(),
        "profiles": {role: {"uuid": "AAAAAAAA-BBBB-CCCC-DDDD-" + "0" * 11 + str(i), "sha256": "a" * 64}
                     for i, role in enumerate(("host", "extension"))},
        "toolchain": {"xcode": "synthetic Xcode", "xcodegen": "synthetic XcodeGen"},
        "tests": {"source_revision": "a" * 40, "run_reference": "synthetic assertions only"},
        "backend": {"deployment": "synthetic-stage", "source_revision": "b" * 40,
                    "config_version": "synthetic-1", "schema_version": "v0.1", "contract_version": "v0.1", "rules_version": "synthetic-pending", "migration_reference": "synthetic migration",
                    "rollback_reference": "synthetic rollback"},
        "approval_reference": "synthetic unit test only",
    }


def signed(c, role="host"):
    ent = {
        "application-identifier": c["app_identifier_prefix"] + "." + c[f"{role}_id"],
        "com.apple.developer.team-identifier": c["team_id"], "get-task-allow": False,
        "com.apple.security.application-groups": [c["app_group"]],
        "keychain-access-groups": [c["keychain_group"]],
    }
    if role == "host":
        ent["aps-environment"] = "production"
        ent["com.apple.developer.associated-domains"] = ["applinks:" + urlparse(c["web_url"]).hostname]
    profile = {
        "UUID": c["profiles"][role]["uuid"], "TeamIdentifier": [c["team_id"]],
        "ApplicationIdentifierPrefix": [c["app_identifier_prefix"]],
        "ExpirationDate": dt.datetime(2099, 1, 1), "DeveloperCertificates": [b"synthetic certificate"],
        "Entitlements": {**copy.deepcopy(ent), "beta-reports-active": True},
    }
    info = {
        "CFBundleIdentifier": c[f"{role}_id"], "CFBundleVersion": c["build"],
        "CFBundleShortVersionString": c["version"], "CalledItAPIURL": c["api_url"],
        "CalledItWebURL": c["web_url"], "CalledItReleaseEnvironment": c["environment"],
        "CalledItSourceRevision": c["source_revision"], "CalledItFixtureMode": False,
        "CalledItBuildChannel": c["build_channel"],
        "CalledItExpectedBackendSourceRevision": c["backend"]["source_revision"],
        "CalledItExpectedBackendDeploymentID": c["backend"]["deployment"],
        "CalledItExpectedBackendConfigVersion": c["backend"]["config_version"],
        "CalledItExpectedAPIHost": urlparse(c["api_url"]).hostname,
        "CalledItExpectedCardHost": urlparse(c["web_url"]).hostname,
        "CalledItAppGroup": c["app_group"], "CalledItKeychainGroup": c["keychain_group"],
        "CalledItSupportURL": c["support_url"], "CalledItAPNsEnvironment": "production",
    }
    if role == "extension":
        info["NSExtension"] = {"NSExtensionPointIdentifier": "com.apple.message-payload-provider"}
    return info, ent, profile


class CandidateTests(unittest.TestCase):
    def test_template_is_blocked(self):
        c = json.loads(Path(__file__).with_name("candidate.example.json").read_text())
        with self.assertRaisesRegex(candidate.GateError, "source_revision"):
            candidate.validate_config(c)

    def test_valid_configuration_and_local_export_only(self):
        c = candidate.validate_config(config())
        self.assertEqual(c["build_channel"], "release")
        self.assertEqual(c["environment"], "staging")
        self.assertNotEqual(c["source_revision"], c["backend"]["source_revision"])
        options = plistlib.loads(plistlib.dumps(candidate.export_options(c)))
        self.assertEqual(options["destination"], "export")
        self.assertEqual(options["method"], "app-store-connect")
        self.assertFalse(options["manageAppVersionAndBuildNumber"])
        self.assertEqual(options["provisioningProfiles"][c["extension_id"]], c["profiles"]["extension"]["uuid"])

    def test_invalid_configuration(self):
        for key, value in (("build", "0"), ("build", "17;echo bad"), ("source_revision", "main"),
                           ("api_url", "http://synthetic-stage.convex.cloud"),
                           ("api_url", "https://localhost"), ("web_url", "https://127.0.0.1"),
                           ("api_url", "https://user:pass@example.org"),
                           ("api_url", "https://example.org/?token=redacted"),
                           ("extension_id", "com.other.ext"), ("keychain_group", "WRONG.session"),
                           ("build_channel", "staging"), ("support_url", "http://support.synthetic.org/help"),
                           ("support_url", "https://support.invalid/help"),
                           ("support_url", "https://user:pass@support.synthetic.org/help"),
                           ("support_url", "https://support.synthetic.org/help?token=synthetic")):
            with self.subTest(key=key, value=value):
                c = config()
                c[key] = value
                with self.assertRaises(candidate.GateError):
                    candidate.validate_config(c)

    def test_archive_settings_match_native_runtime_contract(self):
        c = candidate.validate_config(config())
        settings = candidate.archive_settings(c)
        self.assertEqual(settings["CALLED_IT_EXPECTED_API_HOST"], "synthetic-stage.convex.cloud")
        self.assertEqual(settings["CALLED_IT_EXPECTED_CARD_HOST"], "synthetic-stage.convex.site")
        self.assertEqual(settings["CALLED_IT_SUPPORT_URL"], c["support_url"])
        self.assertEqual(settings["CALLED_IT_APP_GROUP"], c["app_group"])
        self.assertEqual(settings["CALLED_IT_KEYCHAIN_GROUP"], c["keychain_group"])
        self.assertEqual(settings["CALLED_IT_APNS_ENVIRONMENT"], "production")
        self.assertEqual(settings["CALLED_IT_BUILD_CHANNEL"], "release")
        self.assertEqual(settings["CALLED_IT_ENVIRONMENT"], "staging")
        self.assertNotEqual(settings["CALLED_IT_SOURCE_REVISION"], settings["CALLED_IT_EXPECTED_BACKEND_SOURCE_REVISION"])

    def test_host_and_extension_profiles(self):
        c = config()
        for role in ("host", "extension"):
            candidate.validate_signed(c, role, *signed(c, role))

    def test_backend_attestation_requires_exact_pin(self):
        c = config()
        actual = {"app": "called-it", "environment": c["environment"],
                  "sourceSha": c["backend"]["source_revision"], "deploymentId": c["backend"]["deployment"],
                  "configVersion": c["backend"]["config_version"], "schemaVersion": "v0.1",
                  "contractVersion": "v0.1", "testAdapters": False}
        candidate.validate_attestation(c, actual)
        for key, value in (("environment", "production"), ("environment", "unconfigured"),
                           ("sourceSha", None), ("deploymentId", "other"),
                           ("configVersion", "other"), ("schemaVersion", "other"),
                           ("contractVersion", "other"), ("testAdapters", True)):
            with self.subTest(key=key, value=value), self.assertRaises(candidate.GateError):
                candidate.validate_attestation(c, {**actual, key: value})

    def test_qa_channel_cannot_make_app_store_candidate(self):
        c = config()
        c["build_channel"] = "qa"
        candidate.validate_config(c)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config.json"
            att = root / "attestation.json"
            cfg.write_text(json.dumps(c))
            att.write_text("{}")
            with patch("sys.argv", ["candidate.py", "archive", "--config", str(cfg), "--attestation", str(att)]), \
                    patch("candidate.validate_attestation"), patch("candidate.run") as child:
                with self.assertRaisesRegex(candidate.GateError, "requires release channel"):
                    candidate.main()
                child.assert_not_called()

    def test_entitlement_and_profile_failures(self):
        c = config()
        changes = (
            ("ent", "get-task-allow", True), ("ent", "aps-environment", "development"),
            ("ent", "application-identifier", "SYNTHETIC1.com.other"),
            ("ent", "keychain-access-groups", []), ("ent", "com.apple.security.application-groups", []),
            ("ent", "com.apple.developer.extra", True),
            ("profile", "ProvisionedDevices", ["synthetic-device"]),
            ("profile", "ProvisionsAllDevices", True), ("profile", "TeamIdentifier", ["OTHERTEAM1"]),
            ("profile", "ExpirationDate", dt.datetime(2000, 1, 1)),
            ("profile", "DeveloperCertificates", [b"other synthetic certificate"]),
            ("info", "CalledItFixtureMode", True), ("info", "CalledItFixtureMode", "false"),
            ("info", "CalledItAPIURL", "https://other-stage.convex.cloud"),
            ("info", "CFBundleVersion", "18"), ("info", "CalledItSourceRevision", "c" * 40),
            ("info", "CalledItBuildChannel", "qa"),
            ("info", "CalledItExpectedBackendSourceRevision", "a" * 40),
            ("info", "CalledItExpectedBackendDeploymentID", "other-stage"),
            ("info", "CalledItExpectedBackendConfigVersion", "other-version"),
            ("info", "CalledItExpectedAPIHost", "other-api.synthetic.org"),
            ("info", "CalledItExpectedCardHost", "other-card.synthetic.org"),
            ("info", "CalledItAppGroup", "group.other.synthetic"),
            ("info", "CalledItKeychainGroup", "SYNTHETIC1.other.synthetic"),
            ("info", "CalledItSupportURL", "https://other-support.synthetic.org/help"),
            ("info", "CalledItAPNsEnvironment", "development"),
            ("ent", "com.apple.developer.associated-domains", ["applinks:other-card.synthetic.org"]),
        )
        for section, key, value in changes:
            with self.subTest(section=section, key=key):
                info, ent, profile = signed(c)
                {"ent": ent, "profile": profile, "info": info}[section][key] = value
                with self.assertRaises(candidate.GateError):
                    candidate.validate_signed(c, "host", info, ent, profile)

    def test_profile_keychain_wildcard_but_not_signed_wildcard(self):
        c = config()
        info, ent, profile = signed(c)
        profile["Entitlements"]["keychain-access-groups"] = ["SYNTHETIC1.*"]
        candidate.validate_signed(c, "host", info, ent, profile)
        ent["keychain-access-groups"] = ["SYNTHETIC1.*"]
        with self.assertRaises(candidate.GateError):
            candidate.validate_signed(c, "host", info, ent, profile)

    def test_ipa_traversal_and_symlink_denied(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("../outside", "/absolute"):
                with zipfile.ZipFile(root / "bad.ipa", "w") as z:
                    z.writestr(name, "synthetic")
                with self.assertRaises(candidate.GateError):
                    candidate.unpack_ipa(root / "bad.ipa", root / "unpacked")
            with zipfile.ZipFile(root / "bad.ipa", "w") as z:
                entry = zipfile.ZipInfo("Payload/link")
                entry.external_attr = 0o120777 << 16
                z.writestr(entry, "../../outside")
            with self.assertRaises(candidate.GateError):
                candidate.unpack_ipa(root / "bad.ipa", root / "unpacked")
            self.assertFalse((root / "outside").exists())

    def test_single_host_ipa(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with zipfile.ZipFile(root / "synthetic.ipa", "w") as z:
                z.writestr("Payload/Synthetic.app/Info.plist", plistlib.dumps({"synthetic": True}))
            app = candidate.unpack_ipa(root / "synthetic.ipa", root / "unpacked")
            self.assertEqual(plistlib.loads((app / "Info.plist").read_bytes()), {"synthetic": True})

    def test_child_process_environment_has_no_inherited_credentials(self):
        with patch.dict("os.environ", {"CONVEX_DEPLOY_KEY": "synthetic", "ANTHROPIC_API_KEY": "synthetic"}), \
                patch("candidate.subprocess.run") as sub:
            sub.return_value.returncode = 0
            sub.return_value.stdout = b"synthetic"
            self.assertEqual(candidate.run(["synthetic-command"]), b"synthetic")
            env = sub.call_args.kwargs["env"]
            self.assertNotIn("CONVEX_DEPLOY_KEY", env)
            self.assertNotIn("ANTHROPIC_API_KEY", env)

    def test_bundle_inspection_and_asset_rejection(self):
        c = config()
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "Synthetic.app"
            extension = app / "PlugIns/Synthetic.appex"
            profiles = {}
            for role, bundle in (("host", app), ("extension", extension)):
                bundle.mkdir(parents=True, exist_ok=True)
                info, ent, profile = signed(c, role)
                info["CFBundleExecutable"] = "SyntheticBinary"
                (bundle / "Info.plist").write_bytes(plistlib.dumps(info))
                (bundle / "SyntheticBinary").write_bytes(c["api_url"].encode())
                data = plistlib.dumps(profile)
                (bundle / "embedded.mobileprovision").write_bytes(data)
                c["profiles"][role]["sha256"] = hashlib.sha256(data).hexdigest()
                profiles[str(bundle)] = (ent, data)

            def fake_signing_tools(args, cwd=None):
                self.assertIn(args[0], ("codesign", "security"))
                if args[0] == "security":
                    return profiles[str(Path(args[-1]).parent)][1]
                if "--entitlements" in args:
                    return plistlib.dumps(profiles[args[-1]][0])
                if "--extract-certificates" in args:
                    Path(args[-2] + "0").write_bytes(b"synthetic certificate")
                return b""

            with patch("candidate.run", side_effect=fake_signing_tools):
                inspected = candidate.inspect_app(c, app)
                self.assertEqual(inspected["host"]["bundle_id"], c["host_id"])
                self.assertEqual(inspected["extension"]["profile_sha256"], c["profiles"]["extension"]["sha256"])
                for filename, data in (("fixture.json", b"{}"),
                                       ("unsafe.txt", b"https://other-stage.convex.cloud"),
                                       ("unsafe.txt", b"http://localhost/api/query"),
                                       ("unsafe.txt", b"-----BEGIN PRIVATE KEY----- synthetic marker")):
                    with self.subTest(filename=filename, data=data):
                        asset = app / filename
                        asset.write_bytes(data)
                        with self.assertRaises(candidate.GateError):
                            candidate.inspect_app(c, app)
                        asset.unlink()


if __name__ == "__main__":
    unittest.main()
