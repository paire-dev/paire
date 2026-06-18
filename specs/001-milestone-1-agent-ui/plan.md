# Milestone 1 Implementation Plan: Agent Integration + Local UI Polish

## Summary

Ship Paire Milestone 1 when `paire it` can be completed by agents without hand-holding, the local Review UI gives reviewers GitHub-like change context plus claim-scoped filtering, and the `1.0.0` release path is documented and verified.

GitHub target: `paire-dev/paire-cli`
Issue label: `plan`
If the `plan` label is missing, create it first with description `Implementation planning issue`.

## Key Changes

- Improve generated agent instructions in `install-agent-instructions.ts` and draft instructions in `review-draft.ts` with a worked example, clearer claim anatomy, `N|` / `-N|` guidance, file coverage rules, thread grouping examples, and apply-retry behavior.
- Keep JSON draft editing as the Milestone 1 agent interface; defer a direct draft mutation API unless evals prove agents consistently fail on JSON edits.
- Add repeatable agent eval coverage in `evals/` for "Use Paire to review my current changes", covering clean committed diffs, dirty worktree reviews, invalid apply retries, prior-claim preservation, and no-clarification completion.
- Add shared review metadata to committed and worktree UI data: deterministic branch summary, file stats, total additions/deletions, and claim-to-file mappings.
- Update the local React UI to show branch summary and `+lines / -lines / files changed`, preserve review burden as claim status metadata, and make claim selection filter the code panel to referenced files.
- Add claim/file/evidence breadcrumb state in the code panel, keep evidence highlighting, and provide a clear way to reset the claim filter.
- Run a release-readiness pass: remove noisy CLI output, normalize `ACTION_REQUIRED` and `PAIRE_APPLY_REJECTED` copy, update quick-start/workflow docs, run CI, build release artifacts, and tag/publish `v1.0.0` if it is not already released.

## Public Interfaces

- Extend `/api/review` and `/api/worktree/review` responses with:
  - `summary: { text: string; source: "goal" | "threads" | "fallback" }`
  - `files: Array<{ path: string; additions: number; deletions: number; summarized?: boolean; claimIds: string[] }>`
  - `stats: { filesChanged: number; additions: number; deletions: number }`
- Keep existing fields backward-compatible: `session`, `git`, `burden`, `generatedAt`, and `threads` remain unchanged.
- Do not add human-editable branch summaries in Milestone 1; derive summaries from `session.goal` first, then thread titles, then branch name.
- Treat comments/agent feedback loop as post-Milestone 1. Existing committed-claim comment plumbing can be used later, but this issue should not add file-level comments or `paire comments`.

## Test Plan

- Run `bun test`, `bun run typecheck`, and `bun run smoke`.
- Add CLI tests for updated draft/instruction output and successful apply-retry loops.
- Add API tests asserting committed and worktree review metadata includes stable summaries, file stats, and claim-file mappings.
- Add frontend-focused verification for claim selection: selecting a claim filters the code panel to evidence files, selecting evidence scrolls/highlights the span, and clearing selection restores all files.
- Manually run `paire it` with Codex and Claude on a real repo change; pass only when each agent reaches a successful apply without asking for extra clarification.

## Assumptions

- Use Bun for all commands and tests.
- Use existing shadcn/Base UI components and lucide icons; do not add Radix UI.
- Package version already reads `1.0.0`; release work means readiness, artifacts, docs, tag/publish verification, not necessarily a version bump.
- Workstream A and Workstream B can run in parallel, but release happens only after both pass acceptance.
