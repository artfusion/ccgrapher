#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Publish every package to npm.
#
#   bash tools/publish.sh 123456     # account has 2FA — pass the current code
#   bash tools/publish.sh            # publishing via a granular access token
#
# npm requires either 2FA or a granular access token with "bypass 2FA" to
# publish; the plain token from `npm login` is not enough on its own. Check
# which you have with `npm profile get`.
#
# With 2FA, nine uploads may outlive a 30-second code. That is fine — grab a
# fresh one and run this again. It checks the registry before each package and
# skips whatever already landed.

set -uo pipefail

OTP="${1:-}"
if [ -n "$OTP" ] && ! [[ "$OTP" =~ ^[0-9]{6}$ ]]; then
  echo "usage: bash tools/publish.sh [6-digit-code]" >&2
  echo "       '$OTP' is not a 6-digit code. Omit it if you publish with a token." >&2
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
  # --otp only when there is one; with a granular token it must be omitted.
  otp_args=()
  [ -n "$OTP" ] && otp_args=(--otp="$OTP")

  if ( cd "$dir" && npm publish --access public "${otp_args[@]}" >/dev/null 2>&1 ); then
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
