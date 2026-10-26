#!/usr/bin/env bash
# Signs the CI "gjc-mobile-unsigned-device" artifact with a team development certificate and
# publishes it to an OTA install directory served over HTTPS (itms-services needs HTTPS).
# Nothing about the signer lives in the repo; every value below comes from the environment:
#
#   GJCM_SIGNING_DIR   holds the development key (wda.key) and certificate (cert.pem)
#   GJCM_ASC_KEY_ID, GJCM_ASC_KEY_PATH, GJCM_ASC_ISSUER   App Store Connect API key
#   GJCM_CERT_ID       App Store Connect id of the development certificate
#   GJCM_OTA_SITE      directory the HTTPS server publishes (needs icon-57.png, icon-512.png)
#   GJCM_OTA_BASE      public HTTPS URL of that directory
#
#   tools/release-ota.sh [run-id]     # default: latest successful ci run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIGNING="${GJCM_SIGNING_DIR:?set GJCM_SIGNING_DIR}"
ASC_KEY_ID="${GJCM_ASC_KEY_ID:?set GJCM_ASC_KEY_ID}"
ASC_KEY_PATH="${GJCM_ASC_KEY_PATH:?set GJCM_ASC_KEY_PATH}"
ASC_ISSUER="${GJCM_ASC_ISSUER:?set GJCM_ASC_ISSUER}"
CERT_ID="${GJCM_CERT_ID:?set GJCM_CERT_ID}"
SITE="${GJCM_OTA_SITE:?set GJCM_OTA_SITE}"
BUNDLE_ID="dev.gajae.gjcmobile"
WIDGET_ID="$BUNDLE_ID.widget"
APP_GROUP="group.dev.gajae.gjcmobile"
PROFILE="$SIGNING/gjcmobile-dev.mobileprovision"
WIDGET_PROFILE="$SIGNING/gjcmobile-widget-dev.mobileprovision"
OTA_BASE="${GJCM_OTA_BASE:?set GJCM_OTA_BASE}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
RUN_ID="${1:-$(gh run list --workflow ci.yml --status success -L 1 --json databaseId -q '.[0].databaseId')}"
[[ -n "$RUN_ID" ]] || { echo "no successful ci run" >&2; exit 1; }
gh run download "$RUN_ID" -n gjc-mobile-unsigned-device -D "$WORK/artifact"
COMMIT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["commit"])' "$WORK/artifact/build-info.json")"
BUILD="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["build"])' "$WORK/artifact/build-info.json")"

# The app and its widget extension each need their own profile, both carrying the shared App Group.
python3 "$ROOT/tools/asc_profile.py" --key-id "$ASC_KEY_ID" --key-path "$ASC_KEY_PATH" --issuer "$ASC_ISSUER" \
  --cert-id "$CERT_ID" --bundle-id "$BUNDLE_ID" --app-group "$APP_GROUP" --out "$PROFILE"
python3 "$ROOT/tools/asc_profile.py" --key-id "$ASC_KEY_ID" --key-path "$ASC_KEY_PATH" --issuer "$ASC_ISSUER" \
  --cert-id "$CERT_ID" --bundle-id "$WIDGET_ID" --app-group "$APP_GROUP" --name "GJC Mobile Widget Development" \
  --out "$WIDGET_PROFILE"

mkdir -p "$WORK/package/Payload"
unzip -q "$WORK/artifact/GjcMobile-unsigned-device.zip" -d "$WORK/package/Payload"
VERSION="$(python3 -c 'import plistlib,sys;print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleShortVersionString"])' "$WORK/package/Payload/GjcMobile.app/Info.plist")"
# zsign matches each -m profile to the bundle with that id (needs a zsign with multi-profile support).
zsign -f -k "$SIGNING/wda.key" -c "$SIGNING/cert.pem" -m "$PROFILE" -m "$WIDGET_PROFILE" -b "$BUNDLE_ID" \
  -o "$WORK/GjcMobile.ipa" "$WORK/package" >/dev/null
unzip -l "$WORK/GjcMobile.ipa" | grep -q 'Payload/GjcMobile.app/embedded.mobileprovision'
unzip -p "$WORK/GjcMobile.ipa" Payload/GjcMobile.app/PlugIns/GjcWidget.appex/embedded.mobileprovision \
  | openssl smime -inform der -verify -noverify 2>/dev/null | grep -q "\.$WIDGET_ID</string>" \
  || { echo "widget extension is not signed with the $WIDGET_ID profile" >&2; exit 1; }
SHA="$(sha256sum "$WORK/GjcMobile.ipa" | cut -d' ' -f1)"

install -m 0644 "$WORK/GjcMobile.ipa" "$SITE/GjcMobile.ipa.tmp" && mv -f "$SITE/GjcMobile.ipa.tmp" "$SITE/GjcMobile.ipa"
python3 - "$SITE" "$OTA_BASE" "$BUNDLE_ID" "$VERSION" "$BUILD" "$COMMIT" "$SHA" <<'PY'
import datetime, json, os, plistlib, sys
site, base, bundle, version, build, commit, sha = sys.argv[1:8]
manifest = {"items": [{
    "assets": [
        {"kind": "software-package", "url": f"{base}/GjcMobile.ipa"},
        {"kind": "display-image", "url": f"{base}/icon-57.png"},
        {"kind": "full-size-image", "url": f"{base}/icon-512.png"},
    ],
    "metadata": {"bundle-identifier": bundle, "bundle-version": version, "kind": "software", "title": "가재코드"},
}]}
with open(os.path.join(site, "manifest.plist"), "wb") as fh:
    plistlib.dump(manifest, fh)
info = {"version": version, "build": build, "commit": commit, "sha256": sha,
        "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
tmp = os.path.join(site, "build.json.tmp")
with open(tmp, "w") as fh:
    json.dump(info, fh)
os.replace(tmp, os.path.join(site, "build.json"))
PY

# Verify what the phone will download, not what we think we published.
SERVED="$(curl -sf --max-time 120 "$OTA_BASE/GjcMobile.ipa" | sha256sum | cut -d' ' -f1)"
[[ "$SERVED" == "$SHA" ]] || { echo "served ipa hash mismatch: $SERVED" >&2; exit 1; }
curl -sf --max-time 30 "$OTA_BASE/manifest.plist" | grep -q "$BUNDLE_ID"
echo "published $VERSION ($BUILD) commit ${COMMIT:0:7} sha256=$SHA"
echo "install page: $OTA_BASE/"
