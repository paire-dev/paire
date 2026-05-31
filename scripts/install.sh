#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

REPO="${PAIRE_REPO:-paire-dev/paire-cli}"
VERSION="${PAIRE_VERSION:-latest}"
INSTALL_DIR="${PAIRE_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="${PAIRE_BASE_URL:-}"
GITHUB_TOKEN="${PAIRE_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"

fail() {
  printf 'paire install: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$1"
    return
  fi
  fail "missing sha256sum or shasum"
}

download() {
  local url="$1"
  local output="$2"
  if [[ -n "$GITHUB_TOKEN" && "$url" == https://github.com/* ]]; then
    curl --fail --location --silent --show-error \
      --header "Authorization: Bearer ${GITHUB_TOKEN}" \
      --header "X-GitHub-Api-Version: 2022-11-28" \
      "$url" \
      --output "$output"
    return
  fi
  curl --fail --location --silent --show-error "$url" --output "$output"
}

need uname
need curl
need mktemp

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET="paire-${OS}-${ARCH}"

if [[ -n "$BASE_URL" ]]; then
  ASSET_URL="${BASE_URL%/}/${ASSET}"
  CHECKSUMS_URL="${BASE_URL%/}/SHA256SUMS"
elif [[ "$VERSION" == "latest" ]]; then
  ASSET_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
  CHECKSUMS_URL="https://github.com/${REPO}/releases/latest/download/SHA256SUMS"
else
  ASSET_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
  CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

download "$ASSET_URL" "$TMP_DIR/$ASSET"
download "$CHECKSUMS_URL" "$TMP_DIR/SHA256SUMS"

grep -E "  ${ASSET}$" "$TMP_DIR/SHA256SUMS" >"$TMP_DIR/SHA256SUMS.${ASSET}" ||
  fail "checksum file does not contain ${ASSET}"
(cd "$TMP_DIR" && checksum "SHA256SUMS.${ASSET}")

mkdir -p "$INSTALL_DIR"
chmod 0755 "$TMP_DIR/$ASSET"
if command -v install >/dev/null 2>&1; then
  install -m 0755 "$TMP_DIR/$ASSET" "$INSTALL_DIR/paire"
else
  cp "$TMP_DIR/$ASSET" "$INSTALL_DIR/paire"
  chmod 0755 "$INSTALL_DIR/paire"
fi

printf 'Installed paire to %s\n' "$INSTALL_DIR/paire"
printf 'Run: paire --help\n'
