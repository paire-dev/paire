# Paire CLI

Private Bun CLI for local, LLM-free review state that coding agents can drive.

Paire does not call a model. A coding agent commits code, runs `paire review`, reads the packet Paire creates, writes structured review JSON, and applies it with `paire review --apply`. Paire owns Git diff detection between commits, stale-state prevention, local review memory, and the local browser review UI.

## Requirements

- Bun
- Git

The compiled binary is enough for end users. Bun is only required for development, tests, and builds.

## Development

Install dependencies:

```sh
bun install
```

Run from source:

```sh
bun src/cli.ts --help
bun src/cli.ts start --base main --goal "Review current changes"
bun src/cli.ts review
```

Run checks:

```sh
bun run typecheck
bun test
```

Run an inspectable real CLI smoke sandbox:

```sh
bun run smoke
```

The smoke script creates a temporary Git repo, runs real Paire commands, applies hardcoded agent JSON, and prints the sandbox paths for manual inspection.

## Usage

Inside a Git repo:

```sh
paire start --base main --goal "Review current changes"
paire review
```

Paire reviews committed code only. If the worktree is dirty, `paire review` prints `PAIRE_NEEDS_COMMITTED_CHANGES` and does not create a packet or open the browser. Commit or discard the worktree changes, then run `paire review` again.

If `HEAD` changed since the last applied Paire revision and the worktree is clean, `paire review` prints:

```txt
PAIRE_AGENT_ACTION_REQUIRED

Paire detected changes since revision <id>.
Analyze this packet:
<absolute packet path>

Then write the review update JSON and run:
paire review --apply <absolute result path>
```

The coding agent should read the packet, write the result JSON, then run:

```sh
paire review --apply /path/to/agent-result.json
```

When the applied review matches the current `HEAD`, `paire review` opens the browser UI at `127.0.0.1`.

Commands:

```txt
paire start
paire review
paire it
paire status
paire sync
paire review --apply <file>
paire review --stdin
```

## Local State

Default locations:

```txt
~/.paire/paire.db
~/.paire/artifacts/
```

Use `PAIRE_HOME` to isolate state:

```sh
PAIRE_HOME="$(mktemp -d)" paire start --base main
```

Paire does not write review state into the target repository by default. Paire revisions are tied to commit SHAs, so it does not snapshot dirty worktree files.

## Build

Build the development binary for the current machine:

```sh
bun run build
./dist/paire --help
```

Build a release asset for the current machine:

```sh
bun run release:local
```

This writes:

```txt
dist/releases/paire-${OS}-${ARCH}
dist/releases/SHA256SUMS
```

The release script derives `OS` and `ARCH` from trusted system commands and fixed mappings:

```sh
OS="$(uname -s)"      # Darwin -> darwin, Linux -> linux
ARCH="$(uname -m)"    # x86_64/amd64 -> x64, arm64/aarch64 -> arm64
```

Unsupported values fail closed. The script never evaluates detected values as shell code.

## Install

From a private GitHub release, use a token with release asset access:

```sh
curl -fsSLo /tmp/paire-install.sh \
  https://raw.githubusercontent.com/paire-dev/paire-cli/main/scripts/install.sh
less /tmp/paire-install.sh
PAIRE_GITHUB_TOKEN="$GITHUB_TOKEN" bash /tmp/paire-install.sh
```

The short form is:

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire-cli/main/scripts/install.sh |
  PAIRE_GITHUB_TOKEN="$GITHUB_TOKEN" bash
```

The installer:

- detects `OS-ARCH` from `uname`
- downloads `paire-${OS}-${ARCH}` from the release
- downloads `SHA256SUMS`
- verifies the binary checksum before installing
- installs to `~/.local/bin/paire` by default

Pin a version or install elsewhere:

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire-cli/main/scripts/install.sh |
  PAIRE_GITHUB_TOKEN="$GITHUB_TOKEN" PAIRE_VERSION=v0.1.0 PAIRE_INSTALL_DIR="$HOME/bin" bash
```

For local release testing:

```sh
bun run release:local
PAIRE_BASE_URL="file://$(pwd)/dist/releases" PAIRE_INSTALL_DIR="$(mktemp -d)" bash scripts/install.sh
```

## Release Assets

The installer expects these asset names:

```txt
paire-darwin-arm64
paire-darwin-x64
paire-linux-arm64
paire-linux-x64
SHA256SUMS
```

Secure `OS-ARCH` generation steps:

1. Detect OS with `uname -s`.
2. Map only known values: `Darwin -> darwin`, `Linux -> linux`.
3. Detect architecture with `uname -m`.
4. Map only known values: `x86_64|amd64 -> x64`, `arm64|aarch64 -> arm64`.
5. Reject anything else.
6. Build the asset name as `paire-${OS}-${ARCH}` after mapping.
7. Generate checksums from final files:

```sh
cd dist/releases
shasum -a 256 paire-* > SHA256SUMS
```

Build each platform on a matching OS/architecture runner. Do not hand-rename binaries across platforms.
