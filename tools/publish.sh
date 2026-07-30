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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

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

  # Pack with pnpm, upload with npm — each does the half the other cannot.
  #
  # Only pnpm understands the workspace: protocol and rewrites `workspace:*`
  # to a real version at pack time; `npm publish` ships the literal string and
  # produces packages that die on install with `Unsupported URL Type
  # "workspace:"`. That shipped once, as 0.1.0.
  #
  # But `pnpm publish` cannot complete npm's browser auth non-interactively,
  # whereas `npm publish <tarball>` can — and uploading a tarball leaves its
  # contents, including the rewritten deps, untouched.
  tgz=$( cd "$dir" && pnpm pack --pack-destination "$TMP" 2>/dev/null | tail -1 )
  if [ -z "$tgz" ] || [ ! -f "$tgz" ]; then
    echo "  ✗ could not pack $name"; exit 1
  fi

  # Never ship a tarball that still carries the workspace: protocol.
  if tar -xzOf "$tgz" package/package.json | grep -q '"workspace:'; then
    echo "  ✗ $name packed with an unresolved workspace: dependency — refusing to publish"
    exit 1
  fi

  if [ -n "$OTP" ]; then
    ok=$( npm publish "$tgz" --access public --otp="$OTP" >/dev/null 2>&1 && echo yes )
  else
    ok=$( npm publish "$tgz" --access public >/dev/null 2>&1 && echo yes )
  fi

  if [ "$ok" = "yes" ]; then
    published=$((published + 1))
  else
    echo
    echo
    echo "  ✗ stopped at $name. Re-run when fixed — the $published already"
    echo "    published will be skipped, so nothing is lost."
    if [ -n "$OTP" ]; then
      echo "    Most likely the code expired; get a fresh one."
    else
      echo "    Publishing with a token — check it has write access and is"
      echo "    in scope for @ccgrapher/*. The error itself:"
    fi
    npm publish "$tgz" --access public 2>&1 | grep -iE "error|authenticate" | head -5 | sed 's/^/      /' 
    exit 1
  fi
done

echo
echo "Done. $published published, $skipped already there."
echo
echo "Check it works from anywhere:"
echo "  npx @ccgrapher/cli lint <spec.yaml>"
