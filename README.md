# Paire CLI

Local, LLM-free review state for coding agents. Paire detects Git changes between commits, exports review packets, and hosts a browser UI. Agents read the packet, write review JSON, and apply it with `paire review --apply`.

**Requirements:** Git. The release binary needs no Bun.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh | bash
```

Inspect first, then run:

```sh
curl -fsSLo /tmp/paire-install.sh \
  https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh
less /tmp/paire-install.sh
bash /tmp/paire-install.sh
```

Installs to `~/.local/bin/paire` by default and links `paire` into
`/usr/local/bin` when that directory is writable. If `/usr/local/bin` is not
writable, the installer prints the optional `sudo` command and, when running in
an interactive terminal, asks before running it. The link makes the command
visible to coding agents and GUI apps that do not load your shell startup files.

Pin a version or change the target:

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh |
  PAIRE_VERSION=v0.1.0 PAIRE_INSTALL_DIR="$HOME/bin" bash
```

Change or skip the global link:

```sh
curl -fsSL https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh |
  PAIRE_GLOBAL_LINK_DIR="$HOME/bin" bash

curl -fsSL https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh |
  PAIRE_SKIP_GLOBAL_LINK=1 bash
```

## Usage

In a Git repo:

```sh
paire start --base main --goal "Review current changes"
paire review
```

Paire reviews **committed** code only. With a dirty worktree, `paire review` prints `PAIRE_NEEDS_COMMITTED_CHANGES` and does not build a packet from uncommitted files. Commit, then run `paire review` again.

When `HEAD` moved since the last applied revision, `paire review` prints **Action required**: read the exported packet (path printed), write review JSON, then:

```sh
paire review --apply /path/to/agent-result.json
```

When the applied review matches `HEAD`, the browser UI opens at `127.0.0.1`.

**Commands**

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

**State** (override with `PAIRE_HOME`):

```txt
~/.paire/paire.db
~/.paire/artifacts/
~/.paire/projects/<project-key>/current-packet.json
```

Sessions are per Git branch. `paire start` reuses or creates the branch session; `paire it` does the same before reviewing. `paire reset` clears branch state and re-baselines to `baseCommit`. State is keyed by remote (`github/<owner>/<repo>/…`) or local folder name plus a repo-root hash. Linked Git worktrees get different repo-root hashes, so their packet export directories and `agent-result.json` files stay isolated even when they share `PAIRE_HOME`.

---

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun src/cli.ts --help
bun run typecheck && bun test
bun run smoke   # temp repo + real CLI smoke
```

**Build**

```sh
bun run build              # ./dist/paire
bun run release:local      # dist/releases/paire-${OS}-${ARCH} + SHA256SUMS
```

**Releases**

Tag to publish all four binaries (`darwin`/`linux` × `arm64`/`x64`):

```sh
git tag v0.1.0 && git push origin v0.1.0
```

CI runs on `main`; **Release** workflow can be triggered manually without publishing. Local install smoke:

```sh
bun run release:local
PAIRE_BASE_URL="file://$(pwd)/dist/releases" PAIRE_INSTALL_DIR="$(mktemp -d)" bash scripts/install.sh
```

Release assets: `paire-darwin-arm64`, `paire-darwin-x64`, `paire-linux-arm64`, `paire-linux-x64`, and `SHA256SUMS`. Build each platform on a matching runner; map `uname` to `darwin`/`linux` and `x64`/`arm64` only (unsupported values fail closed).
