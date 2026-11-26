#!/usr/bin/env bash
# Build a signed release APK and publish it as an in-app update.
#
#   WD_KEYSTORE_FILE=... WD_KEYSTORE_PASSWORD=... WD_KEY_ALIAS=... WD_KEY_PASSWORD=... \
#   SUPABASE_SERVICE_ROLE_KEY=... scripts/android-publish.sh "Release notes" [--mandatory]
#
# The keystore lives in the Supabase Vault (secret: wd_android_signing_keystore).
# SUPABASE_SERVICE_ROLE_KEY may be omitted when an HTTPS proxy injects it.
# Version name/code are read from android/app/build.gradle; bump them first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOTES="${1:?usage: android-publish.sh NOTES [--mandatory]}"
MANDATORY=false; [ "${2:-}" = "--mandatory" ] && MANDATORY=true
EXPECTED_CERT="2cde0dc6e9d9e00320685975145d7208a042e27962e14cd648c95669e9f73d62"

set -a; . "$ROOT/.env.production"; set +a
URL="$VITE_SUPABASE_URL"; ANON="$VITE_SUPABASE_ANON_KEY"
AUTH=(); [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && AUTH=(-H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

CODE=$(grep -oP 'versionCode \K[0-9]+' "$ROOT/android/app/build.gradle")
NAME=$(grep -oP 'versionName "\K[^"]+' "$ROOT/android/app/build.gradle")
echo "Publishing Waterdrop $NAME (code $CODE)"

LATEST=$(curl -fsS "$URL/rest/v1/rpc/latest_app_release" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d or {}).get("version_code") or 0)')
[ "$CODE" -gt "$LATEST" ] || { echo "versionCode $CODE must be greater than published $LATEST"; exit 1; }

cd "$ROOT"
npm run build >/dev/null
npx cap sync android >/dev/null
(cd android && ./gradlew assembleRelease --no-daemon -q)
APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
APKSIGNER=$(ls -d "${ANDROID_HOME:-/opt/android-sdk}"/build-tools/*/apksigner | sort -V | tail -1)
CERT=$("$APKSIGNER" verify --print-certs "$APK" | grep -oP 'SHA-256 digest: \K[0-9a-f]+' | head -1)
[ "$CERT" = "$EXPECTED_CERT" ] || { echo "APK is signed with the wrong key ($CERT) — installs would fail. Aborting."; exit 1; }

FILE="android/waterdrop-$NAME-$CODE.apk"
SIZE=$(stat -c %s "$APK")
curl -fsS -X POST "$URL/storage/v1/object/app-releases/$FILE" -H "apikey: $ANON" "${AUTH[@]}" \
  -H "Content-Type: application/vnd.android.package-archive" -H "x-upsert: true" --data-binary "@$APK" >/dev/null
PUBLIC="$URL/storage/v1/object/public/app-releases/$FILE"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"version_code":int(sys.argv[1]),"version_name":sys.argv[2],"download_url":sys.argv[3],"file_path":sys.argv[4],"file_size":int(sys.argv[5]),"notes":sys.argv[6],"mandatory":sys.argv[7]=="true"}))' \
  "$CODE" "$NAME" "$PUBLIC" "$FILE" "$SIZE" "$NOTES" "$MANDATORY")
curl -fsS -X POST "$URL/rest/v1/app_releases" -H "apikey: $ANON" "${AUTH[@]}" -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" -d "$BODY"
echo "Published $NAME ($((SIZE / 1024 / 1024)) MB): $PUBLIC"
