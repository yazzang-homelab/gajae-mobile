#!/usr/bin/env python3
"""Ensures the App ID and a development provisioning profile exist on App Store Connect.

Registers the bundle id when missing, then issues an IOS_APP_DEVELOPMENT profile covering every
enabled iPhone/iPad on the team for the given certificate. A profile is reissued whenever the set
of devices differs from the one embedded in the existing profile, so a newly registered phone can
install the next build.

With --app-group the App ID gets the App Groups capability and the profile must carry that group.
The API cannot create a group or assign it to an App ID; when the issued profile lacks it, the
script stops and names the one-time step to do in the developer portal.

Usage: asc_profile.py --key-id ID --key-path AuthKey.p8 --issuer UUID --cert-id CERT \
                      --bundle-id dev.gajae.gjcmobile --out profile.mobileprovision \
                      [--app-group group.dev.gajae.gjcmobile] [--name "GJC Mobile Development"]
"""
import argparse
import base64
import json
import plistlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

BASE = "https://api.appstoreconnect.apple.com"


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(key_id: str, key_path: str, issuer: str) -> str:
    key = serialization.load_pem_private_key(open(key_path, "rb").read(), password=None)
    now = int(time.time())
    header = b64u(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}).encode())
    claims = b64u(json.dumps({"iss": issuer, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"}).encode())
    r, s = decode_dss_signature(key.sign(f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    return f"{header}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


class Asc:
    def __init__(self, bearer: str) -> None:
        self.bearer = bearer

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(BASE + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header("Authorization", f"Bearer {self.bearer}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:600]
            raise SystemExit(f"ASC {method} {path} -> HTTP {exc.code}: {detail}")


def profile_plist(path: str) -> dict:
    raw = subprocess.run(["openssl", "smime", "-inform", "der", "-verify", "-noverify", "-in", path],
                         capture_output=True, check=True).stdout
    return plistlib.loads(raw)


def profile_devices(profile: dict) -> set[str]:
    return set(profile.get("ProvisionedDevices", []))


def profile_groups(profile: dict) -> set[str]:
    return set(profile.get("Entitlements", {}).get("com.apple.security.application-groups", []))


def ensure_app_groups_capability(asc: "Asc", bundle: str, bundle_id: str) -> None:
    caps = asc.call("GET", f"/v1/bundleIds/{bundle}/bundleIdCapabilities")["data"]
    if any(c["attributes"]["capabilityType"] == "APP_GROUPS" for c in caps):
        return
    asc.call("POST", "/v1/bundleIdCapabilities", {"data": {
        "type": "bundleIdCapabilities",
        "attributes": {"capabilityType": "APP_GROUPS"},
        "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bundle}}},
    }})
    print(f"enabled App Groups on {bundle_id}")


def main() -> None:
    ap = argparse.ArgumentParser()
    for name in ("key-id", "key-path", "issuer", "cert-id", "bundle-id", "out"):
        ap.add_argument(f"--{name}", required=True)
    ap.add_argument("--name", default="GJC Mobile Development")
    ap.add_argument("--app-group")
    args = ap.parse_args()
    asc = Asc(token(args.key_id, args.key_path, args.issuer))

    found = asc.call("GET", f"/v1/bundleIds?filter[identifier]={args.bundle_id}&limit=5")["data"]
    found = [b for b in found if b["attributes"]["identifier"] == args.bundle_id]
    if found:
        bundle = found[0]["id"]
    else:
        bundle = asc.call("POST", "/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {
            "identifier": args.bundle_id, "name": "GJC Mobile", "platform": "IOS"}}})["data"]["id"]
        print(f"registered bundle id {args.bundle_id} ({bundle})")
    if args.app_group:
        ensure_app_groups_capability(asc, bundle, args.bundle_id)

    devices = [d for d in asc.call("GET", "/v1/devices?limit=200&filter[status]=ENABLED")["data"]
               if d["attributes"]["deviceClass"] in ("IPHONE", "IPAD")]
    udids = {d["attributes"]["udid"] for d in devices}
    if not devices:
        raise SystemExit("no enabled iPhone/iPad registered on the team")

    try:
        existing = profile_plist(args.out)
        if profile_devices(existing) == udids and (not args.app_group or args.app_group in profile_groups(existing)):
            print(f"profile up to date ({len(udids)} devices): {args.out}")
            return
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass

    # Profiles are immutable; drop stale ones with our name before issuing a new one.
    for p in asc.call("GET", f"/v1/bundleIds/{bundle}/profiles?limit=50")["data"]:
        if p["attributes"]["name"] == args.name:
            asc.call("DELETE", f"/v1/profiles/{p['id']}")
    created = asc.call("POST", "/v1/profiles", {"data": {
        "type": "profiles",
        "attributes": {"name": args.name, "profileType": "IOS_APP_DEVELOPMENT"},
        "relationships": {
            "bundleId": {"data": {"type": "bundleIds", "id": bundle}},
            "certificates": {"data": [{"type": "certificates", "id": args.cert_id}]},
            "devices": {"data": [{"type": "devices", "id": d["id"]} for d in devices]},
        }}})["data"]["attributes"]
    with open(args.out, "wb") as fh:
        fh.write(base64.b64decode(created["profileContent"]))
    if args.app_group and args.app_group not in profile_groups(profile_plist(args.out)):
        raise SystemExit(
            f"profile for {args.bundle_id} lacks App Group {args.app_group}. One-time setup in "
            f"developer.apple.com > Identifiers: create the App Group {args.app_group}, open the App ID "
            f"{args.bundle_id}, App Groups > Configure, tick the group, save; then run this again."
        )
    names = ", ".join(d["attributes"]["name"] for d in devices)
    print(f"issued profile exp={created['expirationDate'][:10]} devices=[{names}] -> {args.out}")


if __name__ == "__main__":
    sys.exit(main())
