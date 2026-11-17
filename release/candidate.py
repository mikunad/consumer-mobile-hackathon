"""Offline-only archive/export/inspection. Never provisions, deploys or uploads."""

import argparse
import datetime as dt
import fnmatch
import hashlib
import io
import json
import os
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlparse


class GateError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise GateError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, cwd=None):
    env = {k: os.environ[k] for k in (
        "PATH", "HOME", "TMPDIR", "DEVELOPER_DIR", "LANG", "LC_ALL"
    ) if k in os.environ}
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, check=False)
    require(result.returncode == 0, f"{Path(args[0]).name} failed; inspect locally, do not publish raw signing logs")
    return result.stdout


def validate_config(c):
    for key in ("source_revision", "version", "build", "build_channel", "environment", "api_url",
                "web_url", "support_url", "team_id", "app_identifier_prefix", "host_id",
                "extension_id", "app_group", "keychain_group",
                "signing_certificate_sha1", "approval_reference"):
        require(isinstance(c.get(key), str) and c[key].strip(), f"Missing {key}")
    require(re.fullmatch(r"[0-9a-f]{40}", c["source_revision"]), "Pin full source SHA")
    require(re.fullmatch(r"[1-9][0-9]*", c["build"]), "Build must be an explicit positive integer string")
    require(re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", c["version"]), "Invalid version")
    require(c["environment"] in ("staging", "production"), "Invalid environment")
    require(c["build_channel"] in ("qa", "release"), "Invalid build channel")
    require(re.fullmatch(r"[A-Z0-9]{10}", c["team_id"]), "Invalid team ID")
    require(re.fullmatch(r"[A-Z0-9]{10}", c["app_identifier_prefix"]), "Invalid App ID prefix")
    require(re.fullmatch(r"[0-9A-Fa-f]{40}", c["signing_certificate_sha1"]), "Pin signing certificate SHA1")
    for key in ("host_id", "extension_id", "app_group", "keychain_group"):
        require(re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", c[key]), f"Invalid {key}")
    require(c["extension_id"].startswith(c["host_id"] + "."), "Extension must be nested under host ID")
    require(c["app_group"].startswith("group."), "Invalid App Group")
    require(c["keychain_group"].startswith(c["app_identifier_prefix"] + "."), "Keychain prefix mismatch")
    for key in ("api_url", "web_url", "support_url"):
        u = urlparse(c[key])
        require(u.scheme == "https" and u.hostname and not u.username and not u.password
                and not u.port and not u.query and not u.fragment,
                f"{key} must be HTTPS without credentials, port, query or fragment")
        require(key == "support_url" or u.path in ("", "/"), f"{key} must be an HTTPS origin")
        require(not re.search(r"localhost|(?:^|\.)test(?:\.|$)|\.invalid$|\.local$|^[\d.:]+$", u.hostname),
                f"Test/local origin forbidden in {key}")
    for role in ("host", "extension"):
        p = c.get("profiles", {}).get(role, {})
        require(isinstance(p.get("uuid"), str) and re.fullmatch(r"[A-Fa-f0-9-]{36}", p["uuid"]), f"Pin {role} profile UUID")
        require(isinstance(p.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", p["sha256"]), f"Pin {role} profile SHA256")
    for key in ("xcode", "xcodegen"):
        require(isinstance(c.get("toolchain", {}).get(key), str) and c["toolchain"][key].strip(), f"Pin {key} version output")
    require(isinstance(c.get("tests", {}).get("source_revision"), str) and re.fullmatch(r"[0-9a-f]{40}", c["tests"]["source_revision"]), "Pin test source SHA")
    require(isinstance(c["tests"].get("run_reference"), str) and c["tests"]["run_reference"].strip(), "Record automated test run reference")
    for key in ("deployment", "source_revision", "config_version", "schema_version", "contract_version", "rules_version", "migration_reference", "rollback_reference"):
        require(isinstance(c.get("backend", {}).get(key), str) and c["backend"][key].strip(), f"Missing backend {key}")
    require(re.fullmatch(r"[0-9a-f]{40}", c["backend"]["source_revision"]), "Pin full backend SHA")
    return c


def validate_attestation(c, actual):
    for key, expected in (("app", "called-it"), ("environment", c["environment"]),
                          ("sourceSha", c["backend"]["source_revision"]),
                          ("deploymentId", c["backend"]["deployment"]),
                          ("configVersion", c["backend"]["config_version"]),
                          ("schemaVersion", c["backend"]["schema_version"]),
                          ("contractVersion", c["backend"]["contract_version"])):
        require(actual.get(key) == expected, f"Backend attestation mismatch: {key}")
    require(actual.get("testAdapters") is False, "Backend test adapters must be false")


def export_options(c):
    return {
        "method": "app-store-connect", "destination": "export",
        "teamID": c["team_id"], "signingStyle": "manual",
        "signingCertificate": c["signing_certificate_sha1"],
        "manageAppVersionAndBuildNumber": False,
        "provisioningProfiles": {
            c["host_id"]: c["profiles"]["host"]["uuid"],
            c["extension_id"]: c["profiles"]["extension"]["uuid"],
        },
    }


def archive_settings(c):
    return {
        "CODE_SIGN_STYLE": "Manual", "DEVELOPMENT_TEAM": c["team_id"],
        "CODE_SIGN_IDENTITY": c["signing_certificate_sha1"],
        "CALLED_IT_DEVELOPMENT_TEAM": c["team_id"],
        "CALLED_IT_HOST_PROFILE": c["profiles"]["host"]["uuid"],
        "CALLED_IT_EXTENSION_PROFILE": c["profiles"]["extension"]["uuid"],
        "MARKETING_VERSION": c["version"], "CURRENT_PROJECT_VERSION": c["build"],
        "CALLED_IT_BUILD_CHANNEL": c["build_channel"],
        "CALLED_IT_API_URL": c["api_url"], "CALLED_IT_WEB_URL": c["web_url"],
        "CALLED_IT_EXPECTED_API_HOST": urlparse(c["api_url"]).hostname,
        "CALLED_IT_EXPECTED_CARD_HOST": urlparse(c["web_url"]).hostname,
        "CALLED_IT_APP_GROUP": c["app_group"], "CALLED_IT_KEYCHAIN_GROUP": c["keychain_group"],
        "CALLED_IT_SUPPORT_URL": c["support_url"], "CALLED_IT_APNS_ENVIRONMENT": "production",
        "CALLED_IT_ENVIRONMENT": c["environment"], "CALLED_IT_SOURCE_REVISION": c["source_revision"],
        "CALLED_IT_EXPECTED_BACKEND_SOURCE_REVISION": c["backend"]["source_revision"],
        "CALLED_IT_EXPECTED_BACKEND_DEPLOYMENT_ID": c["backend"]["deployment"],
        "CALLED_IT_EXPECTED_BACKEND_CONFIG_VERSION": c["backend"]["config_version"],
    }


def permits(expected, actual):
    if isinstance(expected, str) and isinstance(actual, str):
        return fnmatch.fnmatchcase(actual, expected)
    if isinstance(expected, list) and isinstance(actual, list):
        return all(any(permits(e, a) for e in expected) for a in actual)
    return type(expected) is type(actual) and expected == actual


def validate_signed(c, role, info, ent, profile, now=None):
    bundle = c[f"{role}_id"]
    app_id = c["app_identifier_prefix"] + "." + bundle
    pe = profile.get("Entitlements", {})
    now = now or dt.datetime.now(dt.timezone.utc)
    expiry = profile.get("ExpirationDate")
    require(isinstance(expiry, dt.datetime) and expiry.replace(tzinfo=dt.timezone.utc) > now, f"{role}: expired profile")
    require(profile.get("UUID") == c["profiles"][role]["uuid"], f"{role}: profile UUID mismatch")
    require(profile.get("TeamIdentifier") == [c["team_id"]], f"{role}: profile team mismatch")
    require(profile.get("ApplicationIdentifierPrefix") == [c["app_identifier_prefix"]], f"{role}: profile prefix mismatch")
    require(not profile.get("ProvisionedDevices") and not profile.get("ProvisionsAllDevices"), f"{role}: not an App Store profile")
    require(pe.get("beta-reports-active") is True, f"{role}: TestFlight profile required")
    certs = [hashlib.sha1(cert).hexdigest().lower() for cert in profile.get("DeveloperCertificates", [])]
    require(c["signing_certificate_sha1"].lower() in certs, f"{role}: profile certificate mismatch")
    for label, values in (("signature", ent), ("profile", pe)):
        require(values.get("application-identifier") == app_id, f"{role}: {label} App ID mismatch")
        require(values.get("com.apple.developer.team-identifier") == c["team_id"], f"{role}: {label} team mismatch")
        require(values.get("get-task-allow") is not True, f"{role}: debugger entitlement")
        require(c["app_group"] in values.get("com.apple.security.application-groups", []), f"{role}: missing shared App Group")
        groups = values.get("keychain-access-groups", [])
        if label == "profile":
            require(any(g == c["keychain_group"] or (g.endswith(".*") and c["keychain_group"].startswith(g[:-1])) for g in groups), f"{role}: profile disallows shared Keychain")
        else:
            require(c["keychain_group"] in groups, f"{role}: missing explicit shared Keychain")
    for key, value in ent.items():
        require(key in pe and permits(pe[key], value), f"{role}: entitlement not allowed by profile: {key}")
    if role == "host":
        require(ent.get("aps-environment") == pe.get("aps-environment") == "production", "TestFlight host APNs must be production")
        require("applinks:" + urlparse(c["web_url"]).hostname in ent.get("com.apple.developer.associated-domains", []), "Host card associated-domain mismatch")
    elif "aps-environment" in ent:
        require(ent["aps-environment"] == "production", "Development APNs in extension")
    require(info.get("CFBundleIdentifier") == bundle, f"{role}: bundle ID mismatch")
    require(info.get("CFBundleVersion") == c["build"], f"{role}: build mismatch")
    require(info.get("CFBundleShortVersionString") == c["version"], f"{role}: version mismatch")
    for key, expected in (("CalledItAPIURL", c["api_url"]), ("CalledItWebURL", c["web_url"]),
                          ("CalledItExpectedAPIHost", urlparse(c["api_url"]).hostname),
                          ("CalledItExpectedCardHost", urlparse(c["web_url"]).hostname),
                          ("CalledItAppGroup", c["app_group"]), ("CalledItKeychainGroup", c["keychain_group"]),
                          ("CalledItSupportURL", c["support_url"]), ("CalledItAPNsEnvironment", "production"),
                          ("CalledItBuildChannel", c["build_channel"]),
                          ("CalledItReleaseEnvironment", c["environment"]), ("CalledItSourceRevision", c["source_revision"]),
                          ("CalledItExpectedBackendSourceRevision", c["backend"]["source_revision"]),
                          ("CalledItExpectedBackendDeploymentID", c["backend"]["deployment"]),
                          ("CalledItExpectedBackendConfigVersion", c["backend"]["config_version"])):
        require(info.get(key) == expected, f"{role}: {key} mismatch")
    require(info.get("CalledItFixtureMode") is False, f"{role}: fixture mode must be boolean false")
    if role == "extension":
        require(info.get("NSExtension", {}).get("NSExtensionPointIdentifier") == "com.apple.message-payload-provider", "Not a Messages extension")


def inspect_app(c, app):
    extensions = list((app / "PlugIns").glob("*.appex"))
    require(len(extensions) == 1, "Exactly one embedded Messages extension required")
    result = {}
    for role, bundle in (("host", app), ("extension", extensions[0])):
        require(not bundle.is_symlink(), "Symlinked bundles forbidden")
        run(["codesign", "--verify", "--deep", "--strict", str(bundle)])
        raw = run(["codesign", "-d", "--entitlements", ":-", str(bundle)])
        ent = plistlib.loads(raw[raw.find(b"<?xml"):])
        profile_path = bundle / "embedded.mobileprovision"
        require(digest(profile_path) == c["profiles"][role]["sha256"], f"{role}: profile hash mismatch")
        profile = plistlib.loads(run(["security", "cms", "-D", "-i", str(profile_path)]))
        info = plistlib.loads((bundle / "Info.plist").read_bytes())
        validate_signed(c, role, info, ent, profile)
        executable = bundle / info["CFBundleExecutable"]
        require(executable.parent == bundle and executable.is_file() and not executable.is_symlink(), "Invalid executable")
        with tempfile.TemporaryDirectory() as tmp:
            prefix = str(Path(tmp) / "signer")
            run(["codesign", "-d", "--extract-certificates", prefix, str(bundle)])
            require(hashlib.sha1(Path(prefix + "0").read_bytes()).hexdigest() == c["signing_certificate_sha1"].lower(), f"{role}: actual signer mismatch")
        result[role] = {"bundle_id": info["CFBundleIdentifier"], "executable_sha256": digest(executable),
                        "profile_sha256": digest(profile_path), "profile_expires": profile["ExpirationDate"].isoformat()}
    support = urlparse(c["support_url"])
    allowed = {c["api_url"].rstrip("/"), c["web_url"].rstrip("/"), f"{support.scheme}://{support.netloc}"}
    for file in app.rglob("*"):
        require(not file.is_symlink(), "Symlinks forbidden in candidate")
        if not file.is_file():
            continue
        require(not re.search(r"(?:\.xctest|\.p8|\.p12|\.env|fixture|UITests)", file.name, re.IGNORECASE), "Test or secret asset in candidate")
        if file.suffix == ".mobileprovision":
            continue
        data = file.read_bytes()
        require(not re.search(rb"https?://(?:localhost|127\.0\.0\.1|[^/\s\x00]+\.invalid)(?:[:/\s\x00]|$)", data), "Local/test endpoint in candidate")
        require(not re.search(rb"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----", data), "Private key in candidate")
        urls = re.findall(rb"https://[A-Za-z0-9-]+\.convex\.(?:cloud|site)", data)
        require(all(u.decode() in allowed for u in urls), "Unpinned Convex endpoint in candidate")
    return result


def source_manifest(c, root):
    require(run(["git", "rev-parse", "HEAD"], root).decode().strip() == c["source_revision"], "Checkout differs from candidate SHA")
    require(not run(["git", "status", "--porcelain"], root).strip(), "Use a clean candidate checkout")
    files = {}
    for folder in ("convex", "native-imessage", "release", "tests", "vitest.config.ts", "docs/release", "package.json", "package-lock.json"):
        files[folder] = hashlib.sha256(run(["git", "ls-tree", "-r", "HEAD", "--", folder], root)).hexdigest()
    return {"source_revision": c["source_revision"], "git_tree_inventory_sha256": files,
            "backend": c["backend"], "version": c["version"], "build": c["build"],
            "environment": c["environment"], "build_channel": c["build_channel"], "toolchain": c["toolchain"],
            "tests": c["tests"],
            "approval_reference": c["approval_reference"],
            "release_gates": "UNVERIFIED: inspection is not approval or physical/E2E evidence"}


def unpack_ipa(path, target):
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            destination = (target / item.filename).resolve()
            require(destination.is_relative_to(target.resolve()), "Unsafe IPA path")
            require((item.external_attr >> 16) & 0o170000 != 0o120000, "Symlinks forbidden in IPA")
        archive.extractall(target)
    apps = list((target / "Payload").glob("*.app"))
    require(len(apps) == 1, "IPA must contain one host app")
    return apps[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("validate", "attest", "archive", "export", "inspect"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--attestation", type=Path)
    args = parser.parse_args()
    c = validate_config(json.loads(args.config.read_text()))
    if args.action == "validate":
        print("Configuration structurally valid; Apple, backend and release gates remain unverified")
        return
    require(args.attestation is not None, "Supply a saved, authorized backend attestation value JSON")
    validate_attestation(c, json.loads(args.attestation.read_text()))
    if args.action == "attest":
        print("Saved backend metadata matches; it is not cryptographic deployment proof")
        return
    require(c["build_channel"] == "release", "App Store candidate requires release channel, even with staging backend")
    require(sys.platform == "darwin", "Signed candidate actions require the approved Mac; no cloud signing fallback")
    require(args.output is not None and not args.output.exists(), "Choose a new private output directory")
    root = Path(__file__).resolve().parents[1]
    manifest = source_manifest(c, root)
    require(run(["xcodebuild", "-version"]).decode().strip() == c["toolchain"]["xcode"], "Xcode version mismatch")
    require(run(["xcodegen", "--version"]).decode().strip() == c["toolchain"]["xcodegen"], "XcodeGen version mismatch")
    os.umask(0o077)
    out = args.output.resolve()
    out.mkdir(parents=True)
    if args.action == "archive":
        with tempfile.TemporaryDirectory() as tmp:
            native = Path(tmp) / "native-imessage"
            with tarfile.open(fileobj=io.BytesIO(run(["git", "archive", "--format=tar", "HEAD", "native-imessage"], root))) as source:
                for member in source.getmembers():
                    require((member.isfile() or member.isdir()) and (Path(tmp) / member.name).resolve().is_relative_to(Path(tmp).resolve()), "Unsafe native source archive")
                source.extractall(tmp)
            run(["xcodegen", "generate"], native)
            run(["xcodebuild", "-project", str(native / "CalledItMessages.xcodeproj"),
                 "-scheme", "CalledItMessages", "-configuration", "Release",
                 "-destination", "generic/platform=iOS", "-archivePath", str(out / "CalledIt.xcarchive"),
                 "-derivedDataPath", str(out / "DerivedData"), "archive",
                 *[f"{key}={value}" for key, value in archive_settings(c).items()]])
        artifact = out / "CalledIt.xcarchive"
    else:
        require(args.artifact is not None and args.artifact.exists(), "Supply an existing artifact")
        artifact = args.artifact.resolve()
    if artifact.suffix == ".xcarchive":
        apps = list((artifact / "Products/Applications").glob("*.app"))
        require(len(apps) == 1, "Archive must contain one host app")
        manifest["signed_bundles"] = inspect_app(c, apps[0])
    else:
        require(args.action == "inspect" and artifact.suffix == ".ipa", "Expected xcarchive or IPA")
        with tempfile.TemporaryDirectory() as tmp:
            manifest["signed_bundles"] = inspect_app(c, unpack_ipa(artifact, Path(tmp)))
        manifest["ipa_sha256"] = digest(artifact)
    if args.action == "export":
        options = out / "ExportOptions.plist"
        options.write_bytes(plistlib.dumps(export_options(c)))
        run(["xcodebuild", "-exportArchive", "-archivePath", str(artifact),
             "-exportOptionsPlist", str(options), "-exportPath", str(out / "export")])
        ipas = list((out / "export").glob("*.ipa"))
        require(len(ipas) == 1, "Export must produce one IPA")
        with tempfile.TemporaryDirectory() as tmp:
            manifest["signed_bundles"] = inspect_app(c, unpack_ipa(ipas[0], Path(tmp)))
        manifest["ipa_sha256"] = digest(ipas[0])
    manifest["config_sha256"] = digest(args.config)
    manifest["backend_attestation_sha256"] = digest(args.attestation)
    (out / "inspection.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Local inspection written; no upload performed and all release gates still require evidence")


if __name__ == "__main__":
    try:
        main()
    except (GateError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, tarfile.TarError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        sys.exit(1)
