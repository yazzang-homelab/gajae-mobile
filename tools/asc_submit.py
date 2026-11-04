#!/usr/bin/env python3
"""Prepares an App Store version on App Store Connect and submits it for review.

Steps (each is skipped when already in the wanted state, so a rerun after a failure continues):
  1. find or create the iOS App Store version `--version`
  2. wait until build `--build` of that version finishes processing (VALID) and attach it
  3. set What's New on every localization (ko*, zh*, everything else gets the English text)
  4. copy the App Review information (contact, notes) from the previous version when missing
  5. submit for review (reuses an open, unsubmitted review submission)

Without --submit it only prints the state and the plan; nothing is changed.

Usage: asc_submit.py --key-id ID --key-path AuthKey.p8 --issuer UUID --bundle-id dev.gajae.gjcmobile \
                     --version 1.0.1 --build 3000 --whats-new-ko TEXT --whats-new-en TEXT \
                     [--whats-new-zh TEXT] [--submit]
"""
import argparse
import sys
import time
import urllib.parse

from asc_profile import Asc, token

REVIEW_DETAIL_FIELDS = (
    "contactFirstName", "contactLastName", "contactPhone", "contactEmail",
    "demoAccountName", "demoAccountPassword", "demoAccountRequired", "notes",
)
OPEN_SUBMISSION_STATES = ("READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES")


def q(params: dict) -> str:
    return urllib.parse.urlencode(params, safe="[],")


def find_app(asc: Asc, bundle_id: str) -> str:
    apps = asc.call("GET", "/v1/apps?" + q({"filter[bundleId]": bundle_id}))["data"]
    if not apps:
        sys.exit(f"no app record for {bundle_id}")
    return apps[0]["id"]


def versions(asc: Asc, app: str) -> list[dict]:
    path = f"/v1/apps/{app}/appStoreVersions?" + q({"filter[platform]": "IOS", "limit": 20})
    return asc.call("GET", path)["data"]


def find_build(asc: Asc, app: str, version: str, build: str) -> dict | None:
    path = "/v1/builds?" + q({"filter[app]": app, "filter[preReleaseVersion.version]": version,
                              "filter[version]": build, "limit": 1})
    data = asc.call("GET", path)["data"]
    return data[0] if data else None


def wait_build(asc: Asc, app: str, version: str, build: str, minutes: int) -> dict:
    deadline = time.time() + minutes * 60
    while True:
        found = find_build(asc, app, version, build)
        state = found["attributes"]["processingState"] if found else "NOT_FOUND"
        print(f"build {version} ({build}): {state}")
        if state == "VALID":
            return found
        if state in ("FAILED", "INVALID"):
            sys.exit(f"build {version} ({build}) is {state}")
        if time.time() > deadline:
            sys.exit(f"build {version} ({build}) still {state} after {minutes} min")
        time.sleep(30)


def whats_new_for(locale: str, texts: dict[str, str]) -> str:
    if locale.startswith("ko"):
        return texts["ko"]
    if locale.startswith("zh") and texts.get("zh"):
        return texts["zh"]
    return texts["en"]


def review_detail(asc: Asc, version_id: str) -> dict | None:
    try:
        return asc.call("GET", f"/v1/appStoreVersions/{version_id}/appStoreReviewDetail").get("data")
    except SystemExit as exc:
        if "HTTP 404" in str(exc):
            return None
        raise


def version_state(v: dict) -> str:
    attrs = v["attributes"]
    return attrs.get("appStoreState") or attrs.get("appVersionState") or "UNKNOWN"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-id", required=True)
    ap.add_argument("--key-path", required=True)
    ap.add_argument("--issuer", required=True)
    ap.add_argument("--bundle-id", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--build", required=True)
    ap.add_argument("--whats-new-ko", required=True)
    ap.add_argument("--whats-new-en", required=True)
    ap.add_argument("--whats-new-zh", default="")
    ap.add_argument("--wait-minutes", type=int, default=30)
    ap.add_argument("--submit", action="store_true")
    args = ap.parse_args()
    texts = {"ko": args.whats_new_ko, "en": args.whats_new_en, "zh": args.whats_new_zh}

    asc = Asc(token(args.key_id, args.key_path, args.issuer))
    app = find_app(asc, args.bundle_id)
    all_versions = versions(asc, app)
    for v in all_versions:
        print(f"version {v['attributes']['versionString']}: {version_state(v)}")
    target = next((v for v in all_versions if v["attributes"]["versionString"] == args.version), None)
    previous = next((v for v in all_versions if v["attributes"]["versionString"] != args.version), None)
    build = find_build(asc, app, args.version, args.build)
    print(f"build {args.version} ({args.build}): {build['attributes']['processingState'] if build else 'NOT_FOUND'}")

    if not args.submit:
        print("dry run: rerun with --submit to create/attach/submit")
        return

    # Checks that need no change come first, so a refusal leaves App Store Connect untouched.
    path = "/v1/reviewSubmissions?" + q({"filter[app]": app, "filter[platform]": "IOS",
                                          "filter[state]": ",".join(OPEN_SUBMISSION_STATES)})
    open_subs = asc.call("GET", path)["data"]
    busy = [s for s in open_subs if s["attributes"]["state"] != "READY_FOR_REVIEW"]
    if busy:
        sys.exit(f"a review submission is already {busy[0]['attributes']['state']} ({busy[0]['id']})")
    build = wait_build(asc, app, args.version, args.build, args.wait_minutes)

    if target is None:
        target = asc.call("POST", "/v1/appStoreVersions", {"data": {
            "type": "appStoreVersions",
            "attributes": {"platform": "IOS", "versionString": args.version},
            "relationships": {"app": {"data": {"type": "apps", "id": app}}},
        }})["data"]
        print(f"created version {args.version} ({target['id']})")
    state = version_state(target)
    if state not in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"):
        sys.exit(f"version {args.version} is {state}; nothing to submit")
    vid = target["id"]

    if build["attributes"].get("usesNonExemptEncryption") is None:
        asc.call("PATCH", f"/v1/builds/{build['id']}", {"data": {
            "type": "builds", "id": build["id"], "attributes": {"usesNonExemptEncryption": False}}})
        print("build: usesNonExemptEncryption=false")
    asc.call("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build",
             {"data": {"type": "builds", "id": build["id"]}})
    print(f"attached build {args.build}")

    for loc in asc.call("GET", f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]:
        locale = loc["attributes"]["locale"]
        asc.call("PATCH", f"/v1/appStoreVersionLocalizations/{loc['id']}", {"data": {
            "type": "appStoreVersionLocalizations", "id": loc["id"],
            "attributes": {"whatsNew": whats_new_for(locale, texts)}}})
        print(f"whatsNew set: {locale}")

    if review_detail(asc, vid) is None:
        source = review_detail(asc, previous["id"]) if previous else None
        if source is None:
            sys.exit("no App Review information on this or the previous version; fill it in App Store Connect")
        attrs = {k: source["attributes"][k] for k in REVIEW_DETAIL_FIELDS if source["attributes"].get(k) is not None}
        asc.call("POST", "/v1/appStoreReviewDetails", {"data": {
            "type": "appStoreReviewDetails", "attributes": attrs,
            "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
        print(f"review detail copied from {previous['attributes']['versionString']}")

    if open_subs:
        sub = open_subs[0]["id"]
    else:
        sub = asc.call("POST", "/v1/reviewSubmissions", {"data": {
            "type": "reviewSubmissions", "attributes": {"platform": "IOS"},
            "relationships": {"app": {"data": {"type": "apps", "id": app}}}}})["data"]["id"]
    items = asc.call("GET", f"/v1/reviewSubmissions/{sub}/items?" + q({"include": "appStoreVersion"}))["data"]
    if not any((i["relationships"].get("appStoreVersion", {}).get("data") or {}).get("id") == vid for i in items):
        asc.call("POST", "/v1/reviewSubmissionItems", {"data": {
            "type": "reviewSubmissionItems",
            "relationships": {
                "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub}},
                "appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
    done = asc.call("PATCH", f"/v1/reviewSubmissions/{sub}", {"data": {
        "type": "reviewSubmissions", "id": sub, "attributes": {"submitted": True}}})["data"]
    print(f"submitted {args.version} ({args.build}) for review: submission {sub} state {done['attributes']['state']}")


if __name__ == "__main__":
    main()
