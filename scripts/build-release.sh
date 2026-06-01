#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

OUT_DIR="${PAIRE_RELEASE_DIR:-dist/releases}"

fail() {
  printf 'paire release build: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported OS for local build: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture for local build: $(uname -m)" ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
    return
  fi
  fail "missing sha256sum or shasum"
}

need bun
need uname

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET="paire-${OS}-${ARCH}"

mkdir -p "$OUT_DIR"
bun build src/cli.ts --compile --outfile="${OUT_DIR}/${ASSET}"
chmod 0755 "${OUT_DIR}/${ASSET}"

(
  cd "$OUT_DIR"
  sha256_file "$ASSET" >SHA256SUMS
)

printf 'Built %s\n' "${OUT_DIR}/${ASSET}"
printf 'Wrote %s\n' "${OUT_DIR}/SHA256SUMS"
