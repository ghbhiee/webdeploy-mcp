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
# A release directory only counts as installed once it carries the completion
# marker or is the running release; a directory left behind by a failed update
# is discarded and retried.
current_release="$(readlink -f "$INSTALL_ROOT/current" 2>/dev/null || true)"
if [[ -f "$target/.webdeploy-complete" ]] ||
  { [[ -n "$current_release" && -d "$target" ]] && [[ "$(readlink -f "$target")" == "$current_release" ]]; }; then
  echo "$version is already installed."
  exit 0
fi
rm -rf -- "$target"
asset="webdeploy-mcp-${version}.tar.gz"
base="https://github.com/$REPOSITORY/releases/download/$version"
curl -fsSLo "$tmp/$asset" "$base/$asset"
curl -fsSLo "$tmp/SHA256SUMS" "$base/SHA256SUMS"
(cd "$tmp"; grep "  $asset$" SHA256SUMS | sha256sum -c -)
staging="$INSTALL_ROOT/releases/.staging-$version"
rm -rf -- "$staging"
trap 'rm -rf -- "$tmp" "$staging"' EXIT
mkdir -p "$staging"
tar -xzf "$tmp/$asset" -C "$staging" --strip-components=1
(cd "$staging"; pnpm install --frozen-lockfile; WEBDEPLOY_BASE_PATH="${WEBDEPLOY_BASE_PATH:-}" pnpm build)
mv "$staging" "$target"
trap 'rm -rf -- "$tmp"' EXIT
backup="$DATA_DIR/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ).dump"
mkdir -p "$(dirname "$backup")"
pg_dump --format=custom --file "$backup" "$DATABASE_URL"
(cd "$target"; node packages/core/dist/migrate-cli.js)
previous="$(readlink -f "$INSTALL_ROOT/current")"
# Refresh the worker unit and operator scripts from the new release so fixes
# to them reach existing installations. (A refreshed update.sh takes effect on
# the next update run.)
sed -e "s#/etc/webdeploy#$CONFIG_DIR#g" -e "s#/opt/webdeploy#$INSTALL_ROOT#g" \
  -e "s#/var/lib/webdeploy#$DATA_DIR#g" "$target/installer/webdeploy-worker.service" \
  >/etc/systemd/system/webdeploy-worker.service
systemctl daemon-reload
install -m 0755 "$target/installer/update.sh" "$CONFIG_DIR/update.sh"
install -m 0755 "$target/installer/uninstall.sh" "$CONFIG_DIR/uninstall.sh"
ln -sfn "$target" "$INSTALL_ROOT/current"
if ! webdeploy restart; then
  ln -sfn "$previous" "$INSTALL_ROOT/current"
  webdeploy restart || true
  echo "Update failed; restored the previous release." >&2
  exit 1
fi
touch "$target/.webdeploy-complete"
echo "Updated WebDeploy MCP to $version. Pre-update backup: $backup"
