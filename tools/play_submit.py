#!/usr/bin/env python3
"""Uploads a signed AAB to Google Play and releases it on a track (Android Publisher API v3).

Steps, all inside one edit so nothing is visible until the final commit:
  1. open an edit and print every track's current releases
  2. stop unless the AAB's expected version code is above every version code already on a track
  3. upload the AAB and check that Play read the expected version code and the same SHA-256
  4. put a release (name, status, release notes ko-KR / en-US / zh-CN) on `--track`
  5. validate and commit the edit (a `completed` release on production goes to Google review)

Without --submit it stops after step 2 and deletes the edit; nothing is changed. Any failure after
the edit is opened deletes the edit, so a failed run leaves Play as it was.

Usage: play_submit.py --key-file service-account.json --package dev.gajae.gjcmobile --aab app-release.aab \
                      --version-code 141000 --track production --status completed --release-name 1.0.7 \
                      --notes-ko TEXT --notes-en TEXT [--notes-zh TEXT] [--submit]
"""
import argparse
import base64
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
TRACKS = ("production", "beta", "alpha", "internal")
# Play release notes are limited to 500 characters per language.
NOTES_LIMIT = 500


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def access_token(key: dict) -> str:
    now = int(time.time())
    header = b64u(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64u(json.dumps({"iss": key["client_email"], "scope": SCOPE, "aud": key["token_uri"],
                              "iat": now, "exp": now + 3600}).encode())
    signing_input = f"{header}.{claims}".encode()
    private_key = serialization.load_pem_private_key(key["private_key"].encode(), password=None)
    signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": f"{header}.{claims}.{b64u(signature)}"}).encode()
    req = urllib.request.Request(key["token_uri"], data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())["access_token"]
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"token -> HTTP {exc.code}: {exc.read().decode(errors='replace')[:600]}")


class Play:
    def __init__(self, token: str, package: str):
        self.token = token
        self.package = package

    def call(self, method: str, path: str, body: dict | None = None, *, data: bytes | None = None,
             upload: bool = False, timeout: int = 60) -> dict:
        base = UPLOAD_API if upload else API
        url = f"{base}/{self.package}{path}"
        headers = {"Authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["Content-Type"] = "application/octet-stream"
        elif body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:800]
            raise PlayError(f"Play {method} {path} -> HTTP {exc.code}: {detail}") from None


class PlayError(Exception):
    pass


def release_notes(ko: str, en: str, zh: str) -> list[dict]:
    notes = [("ko-KR", ko), ("en-US", en)] + ([("zh-CN", zh)] if zh else [])
    for language, text in notes:
        if len(text) > NOTES_LIMIT:
            raise SystemExit(f"release notes {language}: {len(text)} characters, Play allows {NOTES_LIMIT}")
    return [{"language": language, "text": text} for language, text in notes]


def print_tracks(tracks: list[dict]) -> int:
    """Prints each track's releases and returns the highest version code on any track (0 if none)."""
    highest = 0
    for track in sorted(tracks, key=lambda t: t["track"]):
        releases = track.get("releases", [])
        if not releases:
            print(f"track {track['track']}: (empty)")
        for release in releases:
            codes = release.get("versionCodes", [])
            highest = max([highest] + [int(code) for code in codes])
            print(f"track {track['track']}: {release.get('name', '?')} {codes} {release.get('status', '?')}")
    return highest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--key-file", required=True, help="service account JSON with access to the app")
    parser.add_argument("--package", required=True)
    parser.add_argument("--aab", required=True)
    parser.add_argument("--version-code", required=True, type=int,
                        help="version code the AAB was built with (android.yml run_number + 000)")
    parser.add_argument("--track", required=True, choices=TRACKS)
    parser.add_argument("--status", required=True, choices=("completed", "draft"))
    parser.add_argument("--release-name", required=True, help="release name shown in Play Console, e.g. 1.0.7")
    parser.add_argument("--notes-ko", required=True)
    parser.add_argument("--notes-en", required=True)
    parser.add_argument("--notes-zh", default="")
    parser.add_argument("--submit", action="store_true", help="upload, release and commit")
    args = parser.parse_args()

    notes = release_notes(args.notes_ko, args.notes_en, args.notes_zh)
    with open(args.aab, "rb") as f:
        bundle = f.read()
    digest = hashlib.sha256(bundle).hexdigest()
    print(f"aab {args.aab}: {len(bundle)} bytes, sha256 {digest}, expected version code {args.version_code}")

    with open(args.key_file, encoding="utf-8") as f:
        key = json.load(f)
    play = Play(access_token(key), args.package)
    edit = play.call("POST", "/edits", {})["id"]
    committed = False
    try:
        highest = print_tracks(play.call("GET", f"/edits/{edit}/tracks").get("tracks", []))
        if args.version_code <= highest:
            raise PlayError(f"version code {args.version_code} is not above {highest}, already on a track")
        print(f"plan: {args.track} <- {args.release_name} ({args.version_code}) {args.status}, "
              f"notes {', '.join(n['language'] for n in notes)}")
        if not args.submit:
            print("dry run: nothing uploaded (submit=false)")
            return

        uploaded = play.call("POST", f"/edits/{edit}/bundles?uploadType=media", data=bundle,
                             upload=True, timeout=600)
        print(f"uploaded: version code {uploaded.get('versionCode')}, sha256 {uploaded.get('sha256')}")
        if uploaded.get("versionCode") != args.version_code:
            raise PlayError(f"Play read version code {uploaded.get('versionCode')}, expected {args.version_code}")
        if uploaded.get("sha256") != digest:
            raise PlayError("Play's SHA-256 of the bundle differs from the local file")

        release = {"name": args.release_name, "versionCodes": [str(args.version_code)],
                   "status": args.status, "releaseNotes": notes}
        play.call("PUT", f"/edits/{edit}/tracks/{args.track}", {"track": args.track, "releases": [release]})
        play.call("POST", f"/edits/{edit}:validate")
        play.call("POST", f"/edits/{edit}:commit")
        committed = True
        print(f"committed: {args.track} {args.release_name} ({args.version_code}) {args.status}")
        check = play.call("POST", "/edits", {})["id"]
        print_tracks(play.call("GET", f"/edits/{check}/tracks").get("tracks", []))
        play.call("DELETE", f"/edits/{check}")
    except PlayError as exc:
        sys.exit(str(exc))
    finally:
        if not committed:
            try:
                play.call("DELETE", f"/edits/{edit}")
                print("edit deleted; Play is unchanged")
            except PlayError as exc:
                print(f"could not delete edit {edit}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
