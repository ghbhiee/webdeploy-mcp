#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
CONFIG_DIR="${WEBDEPLOY_CONFIG_DIR:-/etc/webdeploy}"
set -a
# shellcheck disable=SC1091
source "$CONFIG_DIR/webdeploy.env"
set +a
INSTALL_ROOT="${WEBDEPLOY_INSTALL_ROOT:-/opt/webdeploy}"
REPOSITORY="${WEBDEPLOY_REPOSITORY:-ghbhiee/webdeploy-mcp}"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
version="$(curl -fsSL "https://api.github.com/repos/$REPOSITORY/releases/latest" |
  sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid latest release." >&2; exit 1; }
target="$INSTALL_ROOT/releases/$version"
if [[ -d "$target" ]]; then echo "$version is already installed."; exit 0; fi
asset="webdeploy-mcp-${version}.tar.gz"
base="https://github.com/$REPOSITORY/releases/download/$version"
curl -fsSLo "$tmp/$asset" "$base/$asset"
curl -fsSLo "$tmp/SHA256SUMS" "$base/SHA256SUMS"
(cd "$tmp"; grep "  $asset$" SHA256SUMS | sha256sum -c -)
mkdir "$target"
tar -xzf "$tmp/$asset" -C "$target" --strip-components=1
(cd "$target"; pnpm install --frozen-lockfile; WEBDEPLOY_BASE_PATH="${WEBDEPLOY_BASE_PATH:-}" pnpm build)
backup="$DATA_DIR/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ).dump"
mkdir -p "$(dirname "$backup")"
pg_dump --format=custom --file "$backup" "$DATABASE_URL"
(cd "$target"; node packages/core/dist/migrate-cli.js)
previous="$(readlink -f "$INSTALL_ROOT/current")"
ln -sfn "$target" "$INSTALL_ROOT/current"
if ! webdeploy restart; then
  ln -sfn "$previous" "$INSTALL_ROOT/current"
  webdeploy restart || true
  echo "Update failed; restored the previous release." >&2
  exit 1
fi
echo "Updated WebDeploy MCP to $version. Pre-update backup: $backup"
