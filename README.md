# paire

Agent-first CLI for generating local and PR-ready Paire briefs.

## Install

```sh
curl -fsSL https://paire.dev/install | sh
```

Or run from source during development:

```sh
bun run src/cli.ts --version
```

## Commands

- `paire --version` prints the CLI version and exits `0` without prompting.
- `paire --help` prints usage and exits `0` without prompting.
- `paire init -y --hooks=pre-commit,pre-push` writes `.paire/config.yml`, installs hooks, and appends an `AGENTS.md` rule.
- `paire it --no-open` renders a local brief to `.paire/brief.html`.
- `paire push --dry-run` renders the brief that `paire push` posts with `gh pr edit`.
- `paire doctor` prints environment diagnostics for CI, agents, and containers.
- `echo "why" | paire commit-msg` accepts stdin as command input.

## Agent-first guarantees

- Every command supports `--json` for stable machine-readable output.
- Prompts must have flag equivalents; `--answers-file path.json` bulk-feeds answers.
- Output disables color automatically when stdout is not a TTY.
- No command requires environment variables on first run; `paire doctor` tolerates missing `$HOME`.
- Stable exit codes:
  - `0` success
  - `1` generic error
  - `2` user error
  - `3` agent error
  - `4` git state error

## Release

Tag `v0.0.1` or newer to build macOS and Linux binaries with Bun compile. The release workflow attaches:

- `paire-darwin-arm64`
- `paire-darwin-x64`
- `paire-linux-arm64`
- `paire-linux-x64`
