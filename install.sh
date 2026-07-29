#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${WEBDEPLOY_REPOSITORY:-ghbhiee/webdeploy-mcp}"

source_path="${BASH_SOURCE[0]:-}"
if [[ -n "$source_path" ]]; then
  source_dir="$(cd -- "$(dirname -- "$source_path")" && pwd)"
else
  source_dir=""
fi
if [[ -n "$source_dir" && -f "$source_dir/installer/install.sh" ]]; then
  exec bash "$source_dir/installer/install.sh" "$@"
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "Required command not found: $1" >&2; exit 1; }; }
need curl
need sha256sum
need tar

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
version="${WEBDEPLOY_VERSION:-}"
if [[ -z "$version" ]]; then
  version="$(curl -fsSL "https://api.github.com/repos/${REPOSITORY}/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
fi
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Unable to determine a valid release version." >&2
  exit 1
}
asset="webdeploy-mcp-${version}.tar.gz"
base="https://github.com/${REPOSITORY}/releases/download/${version}"
curl -fsSLo "$tmp_dir/$asset" "$base/$asset"
curl -fsSLo "$tmp_dir/SHA256SUMS" "$base/SHA256SUMS"
(
  cd "$tmp_dir"
  grep "  ${asset}$" SHA256SUMS | sha256sum -c -
)
mkdir "$tmp_dir/source"
tar -xzf "$tmp_dir/$asset" -C "$tmp_dir/source" --strip-components=1
exec bash "$tmp_dir/source/installer/install.sh" "$@"
