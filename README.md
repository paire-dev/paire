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
- `paire impact` prints a self-contained prompt that an AI coding agent fills into `.paire/impact.md` (one `<details>` card per impact area, modeled on Paire's product-impact review).
- `paire doctor` prints environment diagnostics for CI, agents, and containers.
- `echo "why" | paire commit-msg` accepts stdin as command input.

### `paire impact`

Designed to be invoked by a coding agent (Claude Code, Codex, Aider, …). The CLI does not call an LLM itself — it gathers PR context (branch, base, commits, file manifest, full patches truncated per file) and emits a structured prompt to stdout. The agent that ran the command consumes that prompt and writes the rendered Markdown.

```sh
paire impact                       # print the prompt to stdout
paire impact --base=develop        # diff against a non-default base
paire impact --output=docs/pr.md   # change where the agent should write
paire impact --prompt-out=.paire/impact.prompt.md   # also persist the prompt
paire impact --json                # wrap prompt + metadata in JSON
```

The output Markdown groups one `<details>` block per item, with area label, impact (`high` / `medium` / `low`), confidence (`observed` / `inferred` / `unknown`), and `file:line-range` evidence — so the file renders as a stack of cards on GitHub.

## Configuration

`paire init` writes `.paire/config.yml`. All fields are optional.

```yaml
version: 1
hooks:
  - pre-commit
  - pre-push
baseBranch: main        # branch to diff against; auto-detected when omitted
brief:
  includeDiff: true
  includeHistory: true
```

### `baseBranch`

Controls which branch `paire it` and `paire push` diff against when generating the brief. When omitted, paire resolves it in this order:

1. The upstream tracking branch, if it points to a different branch (e.g. `origin/main`)
2. `origin/main` → `origin/master` → `main` → `master`

Set this explicitly if your team uses a non-standard base branch:

```yaml
baseBranch: dev
```

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
