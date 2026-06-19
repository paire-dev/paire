# Implementation Plan: Claim Add/Edit API for Review JSON Updates

## Summary

Ship a focused Paire workflow improvement that lets agents update a review through explicit claim-level commands instead of manually editing the entire review JSON draft. The primary interface is a new CLI flow such as `paire claim add` and `paire claim edit`, backed by a review JSON mutation API that validates claim patches, preserves existing review state, and gives agents clear, progressive feedback about pending and completed subagent work.

This plan intentionally replaces broader Milestone 1 UI/release work. The only feature in scope is making claim-scoped review updates easy, safe, and observable for agents.

## Problem

Today, agents are expected to edit a full JSON review draft by hand. That is brittle because the agent must understand the entire JSON schema, preserve unrelated fields, avoid syntax errors, and manually coordinate multiple claim updates. This creates unnecessary cognitive overhead and makes parallel subagent review work harder to track.

A better interface is for agents to declare one review finding at a time:

```sh
paire claim add \
  --session ses_8c46ffd3c-4068-4713-84ee-fef226e0db3ef \
  --title "Add JWT validation to login" \
  --importance critical \
  --thread-id thread_auth \
  --before "Login accepted any password" \
  --after "Login validates JWT tokens" \
  --evidence "src/auth.ts:45-62:Add JWT.verify() call"
```

The CLI and API should own JSON loading, patching, schema validation, conflict detection, and persistence. Agents should only need to provide claim intent and evidence.

## Goals

- Add a claim-scoped mutation interface for review drafts and review sessions.
- Support `paire claim add` for creating a new claim without opening or editing raw JSON.
- Support `paire claim edit` for modifying an existing claim by id, title, thread, status, importance, before/after text, and evidence.
- Preserve and validate the existing review JSON structure automatically.
- Track claim/subagent work state as `pending`, `in_progress`, `complete`, or `blocked` so the UI can show progressive feedback.
- Provide helpful CLI usage, examples, validation errors, and apply/retry guidance.
- Keep the full JSON draft path as a fallback, not the primary agent workflow.

## Non-Goals

- Do not redesign the full local review UI beyond the minimum needed to show claim work state.
- Do not add file-level comments or a general `paire comments` feature.
- Do not require agents to manually edit full review JSON for normal claim creation.
- Do not implement remote collaboration, auth, or cloud sync.
- Do not change the underlying review schema more than necessary to support claim mutation and state.
- Do not include release/tagging work in this feature plan.

## User Experience

### Agent creates a claim

```sh
paire claim add \
  --session ses_8c46ffd3c-4068-4713-84ee-fef226e0db3ef \
  --title "Add JWT validation to login" \
  --importance critical \
  --thread-id thread_auth \
  --before "Login accepted any password" \
  --after "Login validates JWT tokens" \
  --evidence "src/auth.ts:45-62:Add JWT.verify() call"
```

Expected output:

```text
CLAIM_ADDED claim_01J...
Session: ses_8c46ffd3c-4068-4713-84ee-fef226e0db3ef
Thread: thread_auth
Status: pending
Evidence: 1 span

Next:
  paire claim edit --session ses_... --claim claim_01J... --status complete
  paire review apply --session ses_...
```

### Agent updates claim status

```sh
paire claim edit \
  --session ses_8c46ffd3c-4068-4713-84ee-fef226e0db3ef \
  --claim claim_01J... \
  --status complete
```

Expected output:

```text
CLAIM_UPDATED claim_01J...
Status: pending -> complete
```

### Agent adds evidence to an existing claim

```sh
paire claim edit \
  --session ses_8c46ffd3c-4068-4713-84ee-fef226e0db3ef \
  --claim claim_01J... \
  --evidence "src/auth.ts:70-84:Reject expired JWT tokens"
```

Expected output:

```text
CLAIM_UPDATED claim_01J...
Evidence: 1 -> 2 spans
```

### Agent gets help

```sh
paire claim add --help
paire claim edit --help
```

Help output must include:

- Required flags.
- Supported importance values.
- Supported status values.
- Evidence format examples.
- Thread id guidance.
- How to find the current session id.
- A complete copy-pasteable example.

## Public Interfaces

### CLI

Add a new top-level claim command group:

```text
paire claim add [options]
paire claim edit [options]
paire claim list [options]
paire claim show [options]
```

#### `paire claim add`

Required options:

- `--session <session-id>`: target review session.
- `--title <text>`: concise claim title.
- `--importance <low|medium|high|critical>`: finding importance.
- `--thread-id <thread-id>`: thread/group id for related findings.
- `--before <text>`: old behavior or problem statement.
- `--after <text>`: expected fixed behavior or proposed state.
- `--evidence <path:start-end:summary>`: one evidence span. Repeatable.

Optional options:

- `--status <pending|in_progress|complete|blocked>`: defaults to `pending`.
- `--claim-id <claim-id>`: optional deterministic id for advanced callers; otherwise generated.
- `--assignee <label>`: agent/subagent label responsible for the claim.
- `--notes <text>`: short implementation or review note.
- `--json`: print machine-readable output.

#### `paire claim edit`

Required options:

- `--session <session-id>`.
- `--claim <claim-id>`.

Optional patch options:

- `--title <text>`.
- `--importance <low|medium|high|critical>`.
- `--thread-id <thread-id>`.
- `--before <text>`.
- `--after <text>`.
- `--status <pending|in_progress|complete|blocked>`.
- `--evidence <path:start-end:summary>`: append evidence by default.
- `--replace-evidence`: replace evidence instead of appending.
- `--assignee <label>`.
- `--notes <text>`.
- `--json`.

#### `paire claim list`

Print claim ids, titles, importance, status, thread id, assignee, and evidence count for a session. This gives agents a safe way to discover ids before editing.

#### `paire claim show`

Print one claim in readable form, with `--json` support for automation.

### Internal API

Add a small review mutation layer used by the CLI:

```ts
type ClaimStatus = "pending" | "in_progress" | "complete" | "blocked";
type ClaimImportance = "low" | "medium" | "high" | "critical";

type ClaimEvidenceInput = {
  path: string;
  startLine: number;
  endLine: number;
  summary: string;
};

type ClaimAddInput = {
  sessionId: string;
  claimId?: string;
  threadId: string;
  title: string;
  importance: ClaimImportance;
  status?: ClaimStatus;
  before: string;
  after: string;
  evidence: ClaimEvidenceInput[];
  assignee?: string;
  notes?: string;
};

type ClaimEditInput = {
  sessionId: string;
  claimId: string;
  patch: Partial<Omit<ClaimAddInput, "sessionId" | "claimId">> & {
    evidenceMode?: "append" | "replace";
  };
};
```

The API should:

- Load the current review draft/session.
- Validate patch fields before writing.
- Generate ids when omitted.
- Create the thread if `--thread-id` does not exist, or attach to the existing thread if it does.
- Normalize evidence spans.
- Preserve unrelated claims, comments, metadata, and ordering.
- Write atomically to avoid corrupting the review JSON.
- Return structured success/error data for both human and `--json` CLI output.

## Data Model Changes

Add minimal claim metadata:

```ts
type ReviewClaim = {
  id: string;
  threadId: string;
  title: string;
  importance: "low" | "medium" | "high" | "critical";
  status: "pending" | "in_progress" | "complete" | "blocked";
  before: string;
  after: string;
  evidence: Array<{
    path: string;
    startLine: number;
    endLine: number;
    summary: string;
  }>;
  assignee?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};
```

If the current schema already stores equivalent fields under threads, implement this as a compatibility layer rather than a disruptive migration. The CLI should accept claim inputs and map them to the existing persisted shape.

## Validation Rules

- `--session` must reference an existing review session or draft.
- `--title`, `--before`, and `--after` must be non-empty.
- `--importance` must be one of `low`, `medium`, `high`, or `critical`.
- `--status` must be one of `pending`, `in_progress`, `complete`, or `blocked`.
- Evidence must match `path:start-end:summary` or `path:line:summary`.
- Evidence line numbers must be positive integers and `startLine <= endLine`.
- Duplicate evidence spans should be deduplicated unless the summary differs materially.
- Editing a missing claim must fail with a clear `CLAIM_NOT_FOUND` error and suggest `paire claim list --session <id>`.
- Invalid input must not modify the review draft.

## UI Integration

Keep UI work minimal and directly tied to this feature:

- Show each claim's status badge: `pending`, `in_progress`, `complete`, or `blocked`.
- If present, show `assignee` so users can see which subagent owns the work.
- Update the review panel progressively as claim edits arrive in the backing review data.
- Sort or group claims by thread while preserving stable claim order within each thread.
- Do not add large new review surfaces, comment threads, or release dashboards.

## Implementation Steps

1. **Map the current review schema**
   - Identify where session review JSON is created, loaded, validated, and applied.
   - Document how claims/threads/evidence are represented today.
   - Choose the smallest compatibility adapter that supports claim add/edit without forcing a schema rewrite.

2. **Create claim mutation utilities**
   - Add pure functions for `addClaim`, `editClaim`, `listClaims`, and `showClaim`.
   - Add evidence parsing and normalization helpers.
   - Add validation helpers that return stable error codes and actionable messages.

3. **Wire CLI commands**
   - Add `paire claim add`.
   - Add `paire claim edit`.
   - Add `paire claim list` and `paire claim show` for discovery.
   - Add complete help text and copy-pasteable examples.
   - Support `--json` output for automation.

4. **Persist safely**
   - Ensure mutations are atomic.
   - Preserve unrelated JSON fields exactly where possible.
   - Handle concurrent or repeated subagent updates without data loss.
   - Emit concise success output that identifies what changed.

5. **Expose progressive state in UI**
   - Add status badges and optional assignee labels to claim rendering.
   - Ensure updates from claim commands are visible when the UI reloads or refreshes data.
   - Keep styling consistent with existing shadcn/Base UI patterns.

6. **Update agent instructions**
   - Make claim add/edit the recommended workflow.
   - Keep manual JSON editing documented only as an escape hatch.
   - Include the exact `paire claim add` example from this plan.
   - Explain when to mark claims `pending`, `in_progress`, `complete`, or `blocked`.

7. **Test and validate**
   - Add unit tests for evidence parsing, validation, add, edit, list, and show behavior.
   - Add CLI tests for success and error cases.
   - Add regression tests proving unrelated review JSON is preserved.
   - Add UI verification for status/assignee rendering if UI files change.

## Test Plan

- `bun test`.
- `bun run typecheck` if the project defines it.
- CLI success cases:
  - `paire claim add` creates a valid claim.
  - `paire claim edit --status complete` updates only status.
  - `paire claim edit --evidence ...` appends evidence.
  - `paire claim edit --replace-evidence --evidence ...` replaces evidence.
  - `paire claim list` prints discoverable claim ids.
  - `paire claim show --json` emits machine-readable claim data.
- CLI failure cases:
  - Missing session.
  - Missing required fields.
  - Invalid importance.
  - Invalid status.
  - Invalid evidence format.
  - Missing claim id on edit.
- Data preservation tests:
  - Existing claims are unchanged after adding a new claim.
  - Existing unrelated review metadata is unchanged after editing one claim.
  - Invalid edits leave the review JSON byte-for-byte unchanged.

## Acceptance Criteria

- An agent can add a claim with one command and never manually edit full JSON.
- An agent can edit claim status and evidence with one command.
- CLI help is sufficient for a new agent to construct valid commands without knowing the full review JSON schema.
- The mutation API validates inputs before writing and returns stable, actionable error messages.
- Review JSON remains valid after every successful mutation.
- The UI can display claim work state so users get progressive feedback from subagent work.
- Manual full-JSON editing remains available only as a fallback path.
