#!/bin/bash
# Run Coach — clasp deploy script with auto-bump + smoke test
# Usage: ./deploy.sh
#
# What it does:
#   1. clasp push    — uploads all .js files in clasp/ to Apps Script
#   2. clasp deploy  — updates the existing "v2 cloud sync" deployment to
#                       point at the new code (NOT a new deployment URL —
#                       same URL keeps working)
#   3. smoke test    — hits ?action=ping on the deployed URL and verifies
#                       a 200 response with the expected JSON shape
#
# Required:
#   - clasp installed and logged in (`npm i -g @google/clasp && clasp login`)
#   - DEPLOYMENT_ID env var OR a deployment with description containing "v2 cloud sync"
#   - SCRIPT_URL env var OR clasp/script_url file
#
# Exit codes: 0 success, 1 push failed, 2 deploy failed, 3 smoke test failed

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASP_DIR="$SCRIPT_DIR/clasp"

cd "$CLASP_DIR"

# ─── 1. Push all .js files to Apps Script ───
echo "→ [1/3] clasp push..."
if ! clasp push --force 2>&1 | tail -20; then
  echo "✗ clasp push failed" >&2
  exit 1
fi

# ─── 2. Update the existing deployment to a new version ───
# Resolve the deployment ID. Two strategies in order:
#   A. DEPLOYMENT_ID env var (explicit override — wins if set)
#   B. Extract from clasp/script_url — the deployment ID is embedded in
#      the webapp URL between /macros/s/ and /exec, so if you have the
#      URL you have the ID. This is the normal path.
DEPLOYMENT_ID="${DEPLOYMENT_ID:-}"
if [ -z "$DEPLOYMENT_ID" ] && [ -f "$CLASP_DIR/script_url" ]; then
  URL=$(cat "$CLASP_DIR/script_url")
  DEPLOYMENT_ID=$(echo "$URL" | sed -nE 's|.*/macros/s/([^/]+)/exec.*|\1|p')
fi
if [ -z "$DEPLOYMENT_ID" ]; then
  echo "⚠ Could not resolve deployment ID."
  echo "  Either:"
  echo "    A. Set DEPLOYMENT_ID env var explicitly: DEPLOYMENT_ID=AKfyc... ./deploy.sh"
  echo "    B. Save the deployment URL to clasp/script_url:"
  echo "       echo 'https://script.google.com/macros/s/.../exec' > clasp/script_url"
  echo "    C. Or bump the version manually in the Apps Script editor:"
  echo "       Deploy → Manage deployments → Edit pencil → New version → Deploy"
  exit 2
fi

echo "→ [2/3] clasp deploy --deploymentId $DEPLOYMENT_ID..."
DESC="auto-bump $(date +%Y-%m-%d_%H:%M)"
if ! clasp deploy --deploymentId "$DEPLOYMENT_ID" --description "$DESC" 2>&1 | tail -10; then
  echo "✗ clasp deploy failed" >&2
  exit 2
fi

# ─── 3. Smoke test the deployed URL ───
SCRIPT_URL_RESOLVED="${SCRIPT_URL:-}"
if [ -z "$SCRIPT_URL_RESOLVED" ] && [ -f "$CLASP_DIR/script_url" ]; then
  SCRIPT_URL_RESOLVED=$(cat "$CLASP_DIR/script_url")
fi

if [ -z "$SCRIPT_URL_RESOLVED" ]; then
  echo "⚠ SCRIPT_URL not set and clasp/script_url file not found."
  echo "  Skipping smoke test. To enable, save the deployment URL once:"
  echo "    echo 'https://script.google.com/macros/s/.../exec' > clasp/script_url"
  echo "✓ Push + deploy complete (smoke test skipped)"
  exit 0
fi

echo "→ [3/3] Smoke test (GET + POST)..."

# GET smoke test: ?action=ping returns version info
RESPONSE=$(curl -sL --max-time 30 "$SCRIPT_URL_RESOLVED?action=ping&callback=cb")
JSON=$(echo "$RESPONSE" | sed -E 's/^cb\((.*)\);?$/\1/')

if ! echo "$JSON" | grep -q '"ok":true'; then
  echo "✗ GET smoke test FAILED. Response was:"
  echo "  $RESPONSE"
  exit 3
fi
VERSION=$(echo "$JSON" | sed -nE 's/.*"version":"([^"]+)".*/\1/p')
echo "  ✓ GET ?action=ping → ok (version: $VERSION)"

# POST smoke test: verifyPasscode with a deliberately bad passcode.
# This exercises the full doPost path (parse body, checkPasscode, rate
# limit, action dispatch, logActivity, ContentService response) without
# needing to know the real passcode in CI. Apps Script returns a 302
# redirect to googleusercontent, which curl follows by re-issuing as
# GET on a POST 302 (matching browser behavior with "redirect: follow").
LOCATION=$(curl -s --max-time 30 -X POST "$SCRIPT_URL_RESOLVED" \
  -H "Content-Type: text/plain" \
  -d '{"action":"verifyPasscode","passcode":"smoke_test_intentionally_wrong"}' \
  -o /dev/null -D - | grep -i "^location:" | sed 's/^[Ll]ocation: //' | tr -d '\r\n')

if [ -z "$LOCATION" ]; then
  echo "✗ POST smoke test FAILED — no redirect location returned"
  exit 3
fi

POST_RESPONSE=$(curl -s --max-time 30 "$LOCATION")
# Expected response: {"ok":false,"error":"Unauthorized"} — the doPost
# path completed cleanly and returned the auth error. Any HTML response
# means the script crashed before returning JSON (the bytes.map() class
# of bug from 35c5547).
if echo "$POST_RESPONSE" | grep -q '<HTML\|<html\|<!DOCTYPE'; then
  echo "✗ POST smoke test FAILED — script returned HTML (likely runtime crash)"
  echo "  First 300 chars: $(echo "$POST_RESPONSE" | head -c 300)"
  exit 3
fi
if ! echo "$POST_RESPONSE" | grep -q '"error":"Unauthorized"'; then
  echo "✗ POST smoke test FAILED — unexpected response:"
  echo "  $POST_RESPONSE"
  exit 3
fi
echo "  ✓ POST verifyPasscode → handled cleanly"

echo "✓ All smoke tests passed"
echo "✓ Deployment is live at: $SCRIPT_URL_RESOLVED"
