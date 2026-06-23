# Implementation Plan: Claim Command Reflector Refactor

## Summary

Refactor Paire so agents update review state through a first-class claim command reflector instead of editing review JSON drafts. The new workflow is command-driven and diff-first: Paire resolves the active Git review target, emits read-only context, agents add or update claims with `paire claim add` / `paire claim edit`, and Paire reflects those commands into the canonical review state, validation layer, and UI.

This is a complete feature refactor, not a minimal patch. The JSON-draft editing approach should be removed from the primary agent workflow. Agents should never need to open, understand, preserve, or rewrite the full review JSON shape.

## Current Schema Findings

The existing implementation is centered on mutable draft JSON:

- Committed reviews use `ReviewDraft` with `formatVersion`, `packetId`, `sessionId`, `revisionId`, `gitFingerprint`, `files`, and nested `threads[].claims[]`.
- Worktree reviews use `WorktreeReviewDraft` with similar fields plus `worktreeReviewId`, `worktreeHash`, and `gitHead`.
- Claim validation currently accepts `AgentClaim` values nested under threads, with `agentStatus` values of `new`, `unchanged`, `evidence_moved`, `amended`, `invalidated`, and `superseded`.
- Human review state is separate from agent claim state and currently uses `humanStatus: "unreviewed" | "accepted"`.
- Importance currently uses `critical`, `important`, `minor`, and `noise`.
- Evidence currently uses `filePath`, `startLine`, `endLine`, optional `symbol`, optional fingerprints/revision ids, and `change`.
- Coverage validation is currently file-oriented: every changed file must be covered by evidence or acknowledged with a reason.
- Existing generated instructions explicitly tell agents to edit draft JSON in place and run an apply command.

The refactor should replace this with a command/event surface and a canonical review-state schema that Paire owns end-to-end.

## Product Direction

Paire becomes the reflector between agent intent and review state:

1. Paire resolves a review target from Git: an explicit commit range, the current branch's next incremental committed range, or the current uncommitted diff.
2. Paire exports read-only review context for that target.
3. Agents inspect that context and invoke claim commands without passing a session id in the common case.
4. Each claim command is parsed, validated, and reflected into canonical review state immediately.
5. The local UI displays the reflected state progressively, including claim/subagent progress.
6. Finalization validates coverage and consistency without requiring a raw JSON apply step.

## Goals

- Remove manual full-JSON draft editing from the agent workflow.
- Add `paire claim add` for creating review claims directly from CLI flags or structured stdin.
- Add `paire claim edit` for updating claim content, evidence, assignment, and workflow status.
- Add `paire claim list` and `paire claim show` so agents can discover current state safely.
- Make Git review targets the source of truth for review identity; commands auto-detect the active target by default.
- Add `paire review list`, `paire review open`, and `paire review context` so users can discover and reopen previous diff reviews.
- Add a canonical claim-state schema owned by Paire rather than by editable draft JSON.
- Add a reflector layer that converts claim commands into validated review-state updates.
- Support committed and uncommitted reviews through the same claim command model.
- Track subagent work with explicit `workStatus` values and show them in the UI.
- Preserve current validation strengths: file coverage, known-file checks, evidence span checks, stale revision checks, and clear rejection messages.
- Update agent instructions so claim commands are the only documented happy path.

## Non-Goals

- Do not keep manual review JSON editing as a supported workflow.
- Do not describe the new schema as a compatibility adapter for the old draft schema.
- Do not rely on agents preserving unrelated JSON fields.
- Do not add a migration-first implementation path; this plan is for a fresh refactor of the review-state write path and local database schema.
- Do not preserve or migrate the existing local SQLite schema. The implementation may drop/recreate the local database and remove old migration code for this refactor.
- Do not add compatibility fallbacks for old draft/apply payloads or old persisted review rows.
- Do not make `--session` mandatory for claim commands.
- Do not expose sessions as the primary code-review identity in this milestone. Future spec or collaboration work can add a separate `specId`, `workspaceId`, or run identity.
- Do not add an `all-changes` mode in this milestone. A dirty working tree reviews only uncommitted changes on top of `currentCommit`; committed branch changes remain a separate committed review target.
- Do not add remote/cloud collaboration.
- Do not add general-purpose comments or file-level discussion threads.
- Do not ship a large unrelated UI redesign.

## Review Identity: Diff First, Sessions Later

Use Git as the source of truth for review identity. A Paire review should be addressable by a resolved Git target, not by an always-required session flag.

```ts
type ReviewMode = "committed" | "uncommitted";

type ReviewTarget =
  | {
      mode: "committed";
      repoKey: string;
      baseCommit: string;
      currentCommit: string;
    }
  | {
      mode: "uncommitted";
      repoKey: string;
      currentCommit: string;
      worktreeHash: string;
    };

type ReviewLookup =
  | { reviewId: string }
  | { diff: string } // e.g. "main..HEAD" or "abc123..def456"
  | { base: string; head: string }
  | { current: true };
```

`reviewId` should be stable for the normalized target: `repoKey + mode + baseCommit/currentCommit` for committed reviews, and `repoKey + mode + currentCommit + worktreeHash` for uncommitted reviews. Branch names are labels and defaults, not identity. If a branch is renamed but resolves to the same committed target, Paire should reopen the same review.

Claim commands resolve the active review in this order:

1. Explicit `--review <review-id>`.
2. Explicit `--diff <base..head>` or `--base <hash> --head <hash>`.
3. Current uncommitted review if the worktree is dirty.
4. Current branch's next committed review target.

Sessions are not part of the public command happy path, but Paire should keep an internal `sessionId` as review-lineage metadata. `reviewId` identifies one concrete resolved target. `sessionId` groups the sequence of related reviews Paire creates while the user keeps working on the same local review effort, including after new commits, amended commits, rebases, and dirty working-tree revisions. Agents should not need to pass `sessionId`; Paire derives it from the current repo/branch/default flow or from the selected review.

### Incremental Review Lineage

Committed reviews must still support incremental review. The default current-branch flow should find the latest finalized compatible committed review in the same repo/base lineage, then create the next committed review for `previous.currentCommit..HEAD`. The new review stores `sourceReviewId` so Paire can carry forward prior active claims for context while validating file coverage only against the current target's changed files.

When a rebase, force-push, or commit amend changes the hashes, Paire should not rewrite the old `reviewId`. The old review remains addressable by `reviewId` or exact hash pair, but it is stale for the current branch/default target. Paire creates a new review with a new `reviewId`, the same internal `sessionId`, and `sourceReviewId` pointing at the best previous review in that lineage. That lets the agent incrementally amend carried-forward claims against the new diff instead of starting from an empty review.

Explicit hash-pair reviews are exact: `paire review open --diff A..B` reviews `A..B` and does not require a branch or session. Users reopen prior work with:

```text
paire review list [--repo <path>] [--limit 20] [--json]
paire review open <review-id>
paire review open --diff <base..head>
paire review context [--review <review-id>|--diff <base..head>]
```

`paire review list` should show review id, mode, base/current commits when applicable, worktree hash when applicable, branch labels seen at creation/open time, changed-file count, claim count, last updated time, finalized/open status, and source review id when present.

## Canonical Review State Schema

Create a canonical Paire-owned review state that is written only through Paire commands and APIs.

```ts
type ReviewState = {
  schemaVersion: 3;
  reviewId: string;
  sessionId: string;
  target: ReviewTarget;
  sourceReviewId?: string;
  branchLabels: string[];
  goal: string | null;
  files: ReviewFileState[];
  fileProgress: ReviewFileProgress;
  threads: ReviewThreadState[];
  claims: ReviewClaimState[];
  claimHistory: ReviewClaimRevision[];
  events: ReviewEvent[];
  createdAt: string;
  updatedAt: string;
};

type ReviewFileState = {
  path: string;
  additions: number;
  deletions: number;
  summarized: boolean;
  coverageStatus: "pending" | "covered" | "acknowledged";
  acknowledgementReason?: string;
};

type ReviewFileProgress = {
  total: number;
  covered: number;
  acknowledged: number;
  pending: number;
  pendingFiles: string[];
};

type ReviewThreadState = {
  id: string;
  title: string;
  summary?: string;
  order: number;
};

type ClaimLifecycleStatus =
  | "active"
  | "invalidated"
  | "superseded";

type ClaimWorkStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "blocked";

type ClaimImportance = "critical" | "important" | "minor" | "noise";

type ReviewClaimState = {
  id: string;
  threadId: string;
  title: string;
  importance: ClaimImportance;
  lifecycleStatus: ClaimLifecycleStatus;
  workStatus: ClaimWorkStatus;
  humanStatus: "unreviewed" | "accepted";
  before: string | null;
  after: string | null;
  description?: string;
  evidences: ReviewEvidenceState[];
  assignee?: string;
  supersedesClaimId?: string;
  blockedReason?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
};

type ReviewClaimRevision = {
  id: string;
  claimId: string;
  version: number;
  snapshot: ReviewClaimState;
  eventId: string;
  actor: "agent" | "subagent" | "human" | "system";
  createdAt: string;
};

type ReviewEvidenceState = {
  id: string;
  claimId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  change: string;
  symbol?: string;
  fingerprint?: string;
};

type ReviewEvent = {
  id: string;
  type:
    | "claim_added"
    | "claim_edited"
    | "claim_status_changed"
    | "evidence_added"
    | "evidence_removed"
    | "file_acknowledged"
    | "review_finalized";
  actor: "agent" | "subagent" | "human" | "system";
  claimId?: string;
  filePath?: string;
  summary: string;
  createdAt: string;
};
```

### Schema Changes Required

- Replace nested editable `threads[].claims[]` as the write model with top-level canonical `threads` and `claims` collections.
- Split claim status into:
  - `lifecycleStatus` for review semantics: `active`, `invalidated`, `superseded`.
  - `workStatus` for agent/subagent progress: `pending`, `in_progress`, `complete`, `blocked`.
  - `humanStatus` for reviewer approval: `unreviewed`, `accepted`.
- Keep the existing importance vocabulary: `critical`, `important`, `minor`, `noise`.
- Keep the existing evidence vocabulary: `filePath`, `startLine`, `endLine`, and `change`.
- Add stable `evidence.id` values so evidence can be edited or removed independently.
- Add `events[]` so the UI and CLI can reflect progressive updates without diffing whole JSON documents.
- Add `coverageStatus` to files so coverage can be updated by evidence reflection or explicit acknowledgement commands.
- Add `fileProgress` as deterministic file-only progress, derived from `files[].coverageStatus`.
- Add `claimHistory` as the source of claim edit history and time travel. Events remain lightweight activity entries; claim versions live in `claimHistory`, not inside event payloads.
- Replace legacy revision fields (`packetId`, `revisionId`, `gitFingerprint`, `worktreeReviewId`, `gitHead`) with `reviewId` plus the discriminated `ReviewTarget`.
- Keep `sessionId` as internal review-lineage metadata only. It is persisted on review state to support incremental carry-forward across changing Git hashes, but it is not part of the public claim-command selector model.
- If Paire persists generated context artifacts, identify them with a separate `contextId`; do not put context artifact ids into canonical review revision identity.
- Replace generated JSON draft instructions with command instructions.

### File Coverage and Progress Rules

- Initialize every changed file as `coverageStatus: "pending"` unless it is automatically summarized/generated and explicitly acknowledged with a reason.
- Recompute file coverage inside the reflector after every evidence add/remove and file acknowledgement command.
- Mark a file `covered` when at least one active, non-superseded claim has valid evidence whose `filePath` matches the file.
- Mark a file `acknowledged` only through `paire file acknowledge --path <path> --reason <text>` or equivalent system acknowledgement for generated/summarized churn; the reason is required.
- Mark a file back to `pending` when its last valid active evidence is removed and it has no acknowledgement.
- Prefer `covered` over `acknowledged` if a file has both active evidence and an acknowledgement, because evidence is stronger than acknowledgement.
- Derive `fileProgress` from the current file states only: `total`, `covered`, `acknowledged`, `pending`, and sorted `pendingFiles`. Do not estimate progress from claims, events, or agent work status.
- `paire review finalize` succeeds only when `fileProgress.pending === 0` and freshness/evidence validation also passes.

### Claim History Rules

- Store claim edit history in `claimHistory`, not in `events`.
- Create revision `version: 1` when a claim is added, with `snapshot` equal to the created `ReviewClaimState`.
- Append a new `ReviewClaimRevision` whenever a command changes claim content, status, thread assignment, evidence, assignee, supersession, or blocked reason.
- Do not append a claim revision for commands that leave the claim snapshot unchanged.
- Keep `claims[]` as the current materialized state. `claimHistory[]` is append-only and powers UI version browsing, claim-level time travel, and version comparison.
- The UI should be able to show older claim versions by selecting a `claimHistory` entry for a claim, without rewinding the whole review state.

## CLI Surface

Add a top-level command group. Commands default to the auto-detected active review target; use `--review`, `--diff`, or `--base/--head` only when operating on a non-current review.

```text
paire claim add [options]
paire claim edit [options]
paire claim list [options]
paire claim show [options]
paire claim evidence add [options]
paire claim evidence remove [options]
paire file acknowledge [options]
paire review context [options]
paire review list [options]
paire review open [options]
paire review finalize [options]
```

All state-mutating and context commands accept the same target selectors:

- No target flag: auto-detect the current review target from Git.
- `--review <review-id>`: operate on an existing persisted review.
- `--diff <base..head>` or `--base <hash> --head <hash>`: operate on an explicit committed diff.

The common agent path should not require `--session`.

### `paire claim add`

Creates a new claim and immediately reflects it into the active review state.

```sh
paire claim add \
  --title "Add JWT validation to login" \
  --importance critical \
  --thread-id thread_auth \
  --before "Login accepted any password" \
  --after "Login validates JWT tokens" \
  --evidence "src/auth.ts:45-62:Add JWT.verify() call"
```

Required flags:

- `--title <text>`.
- `--importance <critical|important|minor|noise>`.
- `--thread-id <thread-id>`.
- `--before <text|null>`.
- `--after <text|null>`.
- At least one `--evidence <path:start-end:change>` unless the file is acknowledged separately.

Optional flags:

- `--thread-title <text>` to create or rename the thread title.
- `--description <markdown>`.
- `--work-status <pending|in_progress|complete|blocked>`; default `pending`.
- `--assignee <label>`.
- `--claim-id <id>` for deterministic advanced workflows.
- `--review <review-id>` or `--diff <base..head>` when not targeting the auto-detected current review.
- `--json` for machine-readable output.

Expected output:

```text
CLAIM_ADDED claim_01J...
Thread: thread_auth
Importance: critical
Work status: pending
Evidence: 1 span
Coverage: src/auth.ts covered
```

### `paire claim edit`

Updates claim fields without rewriting the entire review.

```sh
paire claim edit \
  --claim claim_01J... \
  --work-status complete
```

Editable fields:

- `--title <text>`.
- `--importance <critical|important|minor|noise>`.
- `--thread-id <thread-id>`.
- `--thread-title <text>`.
- `--before <text|null>`.
- `--after <text|null>`.
- `--description <markdown>`.
- `--lifecycle-status <active|invalidated|superseded>`.
- `--work-status <pending|in_progress|complete|blocked>`.
- `--human-status <unreviewed|accepted>` for UI/human flows only.
- `--assignee <label>`.
- `--blocked-reason <text>`.
- `--supersedes <claim-id>`.
- `--json`.

### `paire claim evidence add`

Adds evidence to an existing claim and updates file coverage.

```sh
paire claim evidence add \
  --claim claim_01J... \
  --evidence "src/auth.ts:70-84:Reject expired JWT tokens"
```

### `paire claim evidence remove`

Removes one evidence span by id and recomputes file coverage.

```sh
paire claim evidence remove \
  --claim claim_01J... \
  --evidence evid_01J...
```

### `paire file acknowledge`

Replaces direct edits to the old `files[]` draft section.

```sh
paire file acknowledge \
  --path bun.lock \
  --reason "Generated lockfile churn"
```

### `paire review finalize`

Runs final validation for the active review state. This replaces `paire review --apply <draft.json>` as the agent completion step.

```sh
paire review finalize
```

Finalize must check:

- Revision freshness.
- Worktree hash freshness for uncommitted reviews.
- Every changed file is covered or acknowledged.
- Evidence paths are known changed files.
- New evidence spans intersect touched ranges where range data exists.
- Required claim fields are present.
- Blocked claims include `blockedReason`.
- Superseded claims include `supersedesClaimId`.

## Reflector API

Create a dedicated module that applies command intents to canonical review state:

```ts
type ReflectorCommand =
  | { type: "claim.add"; input: ClaimAddInput }
  | { type: "claim.edit"; input: ClaimEditInput }
  | { type: "evidence.add"; input: EvidenceAddInput }
  | { type: "evidence.remove"; input: EvidenceRemoveInput }
  | { type: "file.acknowledge"; input: FileAcknowledgeInput }
  | { type: "review.finalize"; input: ReviewFinalizeInput };

type ReflectorResult = {
  state: ReviewState;
  events: ReviewEvent[];
  claimRevisions: ReviewClaimRevision[];
  coverageDelta: Array<{
    path: string;
    before: ReviewFileState["coverageStatus"];
    after: ReviewFileState["coverageStatus"];
  }>;
  fileProgress: ReviewFileProgress;
};
```

The reflector must:

- Resolve the review target from `--review`, `--diff`, `--base/--head`, or current Git state, then load the canonical review state by `reviewId`.
- Validate command input before mutating state.
- Apply exactly one command per transaction.
- Recompute affected file coverage after evidence or acknowledgement changes.
- Recompute deterministic `fileProgress` after any coverage change.
- Append a review event for every successful reflected command.
- Append a `ReviewClaimRevision` for every command that changes a claim snapshot.
- Persist atomically.
- Return human-readable CLI output and optional machine-readable `--json` output.
- Reject invalid commands without changing state.

## Agent Workflow

### Start or refresh context

`paire it` should print a command-oriented prompt instead of a draft-editing prompt:

```text
Review context ready.
Review: rev_...
Target: main..HEAD
Changed files: 4
Inspect:
  paire review context
Add claims:
  paire claim add --title ... --importance ... --thread-id ... --before ... --after ... --evidence path:start-end:change
Finish:
  paire review finalize
```

### Subagent workflow

A parent agent can assign work to subagents by giving each one a file area or thread id. Subagents update progress directly:

```sh
paire claim add --thread-id thread_auth --assignee subagent-auth --work-status in_progress ...
paire claim edit --claim claim_... --work-status complete
```

The UI should show this progressively as each command reflects into state.

## UI Requirements

Update the local review UI to read canonical review state:

- Render top-level `threads` and `claims` by joining `claims.threadId` to `threads.id`.
- Show `workStatus` badges: `pending`, `in_progress`, `complete`, `blocked`.
- Show `lifecycleStatus` separately from `humanStatus`.
- Show `assignee` when present.
- Show reflected event history in a compact activity area or per-claim timestamp summary.
- Show claim history/version browsing from `claimHistory`, allowing reviewers to inspect older versions of a claim without rewinding the whole review.
- Show deterministic file review progress from `fileProgress`: files reviewed, files pending, and pending file list.
- Recompute filters using canonical claim fields rather than draft-agent statuses.
- Continue to support accepting/unaccepting claims through a Paire-owned API endpoint that updates `humanStatus`.

## Validation Requirements

Preserve and move the existing validation logic into the reflector/finalize path:

- Validate ids as public ids with length limits.
- Validate claim title, description, before/after copy, evidence change copy, and thread summary length limits.
- Validate claim importance against `critical`, `important`, `minor`, `noise`.
- Validate lifecycle, work, and human statuses independently.
- Validate evidence path safety and changed-file membership.
- Validate evidence spans against touched ranges when available.
- Validate all changed files are covered or acknowledged before finalize succeeds.
- Validate `fileProgress` is derived from file coverage state and has no pending files before finalize succeeds.
- Validate stale committed targets and stale uncommitted worktree hashes.
- Validate blocked/superseded lifecycle requirements.
- Emit stable error codes such as `CLAIM_NOT_FOUND`, `INVALID_EVIDENCE`, `FILE_NOT_COVERED`, `STALE_REVIEW`, and `INVALID_STATUS`.

## Implementation Steps

1. **Introduce canonical review state**
   - Define `ReviewState`, `ReviewClaimState`, `ReviewClaimRevision`, `ReviewEvidenceState`, `ReviewThreadState`, `ReviewFileState`, `ReviewFileProgress`, and `ReviewEvent` types.
   - Store committed and uncommitted review state in this canonical shape.
   - Key review state by normalized Git target instead of branch-only or mandatory session identity.
   - Add review lineage metadata (`sessionId`, `sourceReviewId`, branch labels) so incremental reviews can carry prior active claims without exposing sessions as CLI selectors.
   - Replace the existing local DB schema wholesale; do not write compatibility migrations for old review/draft tables.
   - Make the local review API read this shape.

2. **Build the reflector module**
   - Add pure reducers for claim add/edit, evidence add/remove, file acknowledge, and review finalize.
   - Add review target resolution helpers for `--review`, `--diff`, `--base/--head`, dirty working trees, and current branch defaults.
   - Add current-branch incremental resolution: latest compatible finalized review becomes `sourceReviewId`; the next target covers `source.currentCommit..HEAD`.
   - Add transaction helpers for load/validate/apply/persist.
   - Add event emission, claim revision append, coverage recomputation, and file progress recomputation.

3. **Replace JSON-draft apply commands**
   - Remove the generated instruction path that tells agents to edit draft JSON.
   - Replace `paire review --apply <draft>` and `paire worktree --apply <draft>` in agent guidance with `paire review finalize`.
   - Keep internal packet/context generation read-only.

4. **Wire CLI commands**
   - Implement `paire claim add`.
   - Implement `paire claim edit`.
   - Implement `paire claim list`.
   - Implement `paire claim show`.
   - Implement `paire claim evidence add`.
   - Implement `paire claim evidence remove`.
   - Implement `paire file acknowledge`.
   - Implement `paire review context`.
   - Implement `paire review list`.
   - Implement `paire review open`.
   - Implement `paire review finalize`.
   - Add `--help` examples for every command.

5. **Update agent instructions**
   - Rewrite installed Paire instructions to describe only command-based review updates.
   - Include copy-pasteable examples.
   - Explain evidence format and safe inspection commands.
   - Explain subagent progress updates via `workStatus`.

6. **Update local UI**
   - Read canonical review state.
   - Display work, lifecycle, and human statuses separately.
   - Show assignee/progress feedback.
   - Show coverage status for changed files.
   - Show deterministic file progress from `fileProgress`.
   - Show claim version history from `claimHistory`.

7. **Move tests to the new workflow**
   - Replace draft-JSON edit tests with claim-command tests.
   - Add reflector reducer tests.
   - Add finalize validation tests.
   - Add UI/API shape tests.

## Test Plan

- `bun test`.
- `bun run typecheck`.
- Command tests:
  - `paire claim add` creates canonical claim state, claim history, and event entries.
  - `paire claim edit --work-status complete` updates progress only and appends a claim revision.
  - `paire claim evidence add` updates claim evidence and file coverage.
  - `paire claim evidence remove` recomputes coverage and file progress.
  - `paire file acknowledge` marks a file acknowledged with a reason and recomputes file progress.
  - `paire review finalize` passes only when review state is fresh and coverage is complete.
  - Claim commands auto-detect the current review target without `--session`.
  - `paire review open --diff A..B` reopens the same committed review as `paire review open <review-id>`.
- Validation tests:
  - Invalid status is rejected without persistence.
  - Unknown claim is rejected without persistence.
  - Unknown file evidence is rejected without persistence.
  - Out-of-range evidence is rejected without persistence.
  - Stale committed target is rejected.
  - Stale uncommitted worktree hash is rejected.
- UI/API tests:
  - Review API returns canonical top-level `threads`, `claims`, `claimHistory`, `files`, `fileProgress`, and `events`.
  - UI renders work status and assignee.
  - UI renders deterministic file progress and pending files.
  - UI can show older claim versions from `claimHistory`.
  - Human status updates mutate only `humanStatus`.

## Acceptance Criteria

- The agent happy path uses only Paire commands, not manual JSON edits.
- The plan and instructions no longer present JSON draft editing as part of the workflow.
- Claim commands update canonical review state immediately and atomically.
- Claim commands do not require `--session` for the current review; they auto-detect the Git review target.
- Review state still persists an internal `sessionId` so rebases/amends/new commits can create a new concrete review while carrying forward prior claims through `sourceReviewId`.
- `paire review finalize` replaces draft apply as the completion gate.
- The canonical schema separates lifecycle, work, and human status.
- The UI can show progressive subagent work from reflected events and work statuses.
- The UI can browse previous versions of a claim from `claimHistory`.
- Review progress is deterministic and file-based via `fileProgress`, including pending file count/list.
- Existing validation guarantees are preserved in the new reflector/finalize architecture.
