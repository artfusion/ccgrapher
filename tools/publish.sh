#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Publish every package to npm.
#
#   bash tools/publish.sh 123456        <- your 6-digit authenticator code
#
# npm requires a 2FA code to publish, and the token from `npm login` cannot
# supply one, so it has to be passed in. Nine uploads may outlive a 30-second
# code — that is fine. Grab a fresh one and run this again; it checks the
# registry before each package and skips whatever already landed.

set -uo pipefail

OTP="${1:-}"
if [ -z "$OTP" ]; then
  echo "usage: bash tools/publish.sh <6-digit-code>" >&2
  echo "       (from your authenticator app)" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Dependency order, so a published package never references a missing one.
PACKAGES=(
  packages/core
  packages/layout
  packages/lint
  packages/render-svg
  packages/render-mermaid
  packages/render-excalidraw
  packages/codegen
  packages/ingest
  apps/cli
)

echo "Building and testing first — never publish something unverified."
pnpm build >/dev/null || { echo "build failed, nothing published" >&2; exit 1; }
pnpm test  >/dev/null 2>&1 || { echo "tests failed, nothing published" >&2; exit 1; }
echo

published=0
skipped=0

for dir in "${PACKAGES[@]}"; do
  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")

  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "  = $name@$version already on npm"
    skipped=$((skipped + 1))
    continue
  fi

  echo "  → publishing $name@$version"
  if ( cd "$dir" && npm publish --access public --otp="$OTP" >/dev/null 2>&1 ); then
    published=$((published + 1))
  else
    echo
    echo "  ✗ stopped at $name."
    echo "    Most likely the code expired. Get a fresh one and run this again —"
    echo "    the $published already published will be skipped."
    exit 1
  fi
done

echo
echo "Done. $published published, $skipped already there."
echo
echo "Check it works from anywhere:"
echo "  npx @ccgrapher/cli lint <spec.yaml>"
