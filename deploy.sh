#!/bin/bash
# Run Coach — clasp deploy script
# Usage: ./deploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/RunCoach-AppScript.js"

echo "→ Deploying Run Coach Apps Script..."
cp "$SOURCE" "$SCRIPT_DIR/clasp/Code.js"
cd "$SCRIPT_DIR/clasp"
clasp push --force
echo "✓ Push complete. Bump the deployment version in the Apps Script editor (Deploy → Manage deployments) to make it live."
