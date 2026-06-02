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

Paire reviews committed code only. If the worktree is dirty, `paire review` prints `PAIRE_NEEDS_COMMITTED_CHANGES`, does not create a packet from dirty files, and opens the existing review UI with a warning that it is not showing the latest worktree changes. Commit the worktree changes, then run `paire review` again.

If `HEAD` changed since the last applied Paire revision and the worktree is clean, `paire review` prints:

```txt
Action required

Paire detected changes since revision <id>.
Analyze the current canonical packet exported at:
<absolute packet path>

Packet preview:
{
  "packetId": "...",
  ...
}

Then write the review update JSON and run:
paire review --apply <absolute result path>
```

The packet JSON is canonical in SQLite. The exported packet path is a stable per-project read handle for the current pending packet, not historical packet storage. `paire review` also prints a generous inline preview and truncates it with a message when the packet is large.

The coding agent should read the current exported packet or use the inline preview, write the result JSON, then run:

```sh
paire review --apply /path/to/agent-result.json
```

When the applied review matches the current `HEAD`, `paire review` opens the browser UI at `127.0.0.1`.

Commands:

```txt
paire start
paire review
paire it
paire install
paire status
paire sync
paire reset
paire server start [--no-open]
paire server stop
paire review --apply <file>
paire review --stdin
```

## Local State

Default locations:

```txt
~/.paire/paire.db
~/.paire/artifacts/
~/.paire/projects/<project-key>/current-packet.json
```

Use `PAIRE_HOME` to isolate state:

```sh
PAIRE_HOME="$(mktemp -d)" paire start --base main
```

Paire does not write review state into the target repository by default. Paire revisions are tied to commit SHAs, so it does not snapshot dirty worktree files.

Sessions are scoped to the current Git branch. Running `paire start` on a branch reuses that branch's existing session when one exists, or creates one when it does not. `paire it` also creates the current branch session when needed before reviewing. Use `paire reset` to clear the current branch's review state and re-baseline the applied revision to `baseCommit`, so the next `paire review` covers all branch changes since the merge-base again.

Project state is isolated by a project key. GitHub remotes use:

```txt
github/<owner>/<repo>/<repo-root-hash>
```

Local repos without a GitHub remote use:

```txt
local/<folder-name>/<repo-root-hash>
```

The hash suffix avoids collisions between multiple local clones of the same repository.

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

## Releases

GitHub Actions builds all four release binaries (`paire-darwin-arm64`, `paire-darwin-x64`, `paire-linux-arm64`, `paire-linux-x64`) on native runners, merges `SHA256SUMS`, and publishes a GitHub release when you push a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

`workflow_dispatch` on the **Release** workflow runs the same builds without publishing (useful to verify CI). Pushes to `main` run **CI** (typecheck, tests, and a linux-x64 build).

## Install

```sh
curl -fsSLo /tmp/paire-install.sh \
  https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh
less /tmp/paire-install.sh
bash /tmp/paire-install.sh
```

Or pipe directly:

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh | bash
```

The installer:

- detects `OS-ARCH` from `uname`
- downloads `paire-${OS}-${ARCH}` from the release
- downloads `SHA256SUMS`
- verifies the binary checksum before installing
- installs to `~/.local/bin/paire` by default

Pin a version or install elsewhere:

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh |
  PAIRE_VERSION=v0.1.0 PAIRE_INSTALL_DIR="$HOME/bin" bash
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
