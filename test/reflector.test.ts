import { expect, test } from "bun:test";

import {
  createReviewState,
  type ReviewState,
  type ReviewTarget,
} from "../src/cli/review-state";
import {
  reduceClaimAdd,
  reduceClaimEdit,
  reduceEvidenceAdd,
  reduceEvidenceRemove,
  reduceFileAcknowledge,
  reduceReviewFinalize,
  type ReflectorApplyOptions,
} from "../src/cli/reflector";

const NOW = "2026-06-25T12:00:00.000Z";
const LATER = "2026-06-25T12:01:00.000Z";

const target: ReviewTarget = {
  mode: "committed",
  repoKey: "repo",
  baseCommit: "base",
  currentCommit: "head",
};

function emptyState() {
  return createReviewState({
    reviewId: "rev_1",
    sessionId: "session_1",
    target,
    createdAt: NOW,
    files: [
      { path: "src/a.ts", additions: 4, deletions: 1, summarized: false },
      { path: "src/b.ts", additions: 2, deletions: 0, summarized: false },
      {
        path: "bun.lock",
        additions: 20,
        deletions: 10,
        summarized: true,
        acknowledgementReason: "Generated lockfile churn",
      },
    ],
  });
}

function context(now = NOW): ReflectorApplyOptions {
  return {
    now,
    touchedRanges: [
      { filePath: "src/a.ts", ranges: [{ startLine: 10, endLine: 12 }] },
      { filePath: "src/b.ts", ranges: [{ startLine: 20, endLine: 22 }] },
    ],
  };
}

function addClaim(state: ReviewState) {
  const result = reduceClaimAdd(
    state,
    {
      actor: "agent",
      claimId: "claim_a",
      threadId: "thread_core",
      threadTitle: "Core",
      title: "Cover A",
      importance: "important",
      before: "A was not covered",
      after: "A is covered",
      evidences: [
        {
          id: "evid_a",
          filePath: "src/a.ts",
          startLine: 11,
          endLine: 12,
          change: "Cover A",
        },
      ],
    },
    context(),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.state;
}

test("claim.add creates canonical claim, event, history, and coverage", () => {
  const state = emptyState();
  const result = reduceClaimAdd(
    state,
    {
      actor: "subagent",
      claimId: "claim_a",
      threadId: "thread_core",
      threadTitle: "Core",
      title: "Cover A",
      importance: "critical",
      workStatus: "in_progress",
      before: "A accepted stale input",
      after: "A validates fresh input",
      description: "Additional context",
      evidences: [
        {
          id: "evid_a",
          filePath: "src/a.ts",
          startLine: 10,
          endLine: 12,
          change: "Validate fresh input",
        },
      ],
      assignee: "subagent-core",
    },
    context(),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(state.claims).toHaveLength(0);
  expect(state.fileProgress.pendingFiles).toEqual(["src/a.ts", "src/b.ts"]);
  expect(result.state.threads).toEqual([
    { id: "thread_core", title: "Core", order: 1 },
  ]);
  expect(result.state.claims[0]).toMatchObject({
    id: "claim_a",
    threadId: "thread_core",
    title: "Cover A",
    importance: "critical",
    lifecycleStatus: "active",
    workStatus: "in_progress",
    humanStatus: "unreviewed",
    assignee: "subagent-core",
  });
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.type).toBe("claim_added");
  expect(result.claimRevisions).toHaveLength(1);
  expect(result.claimRevisions[0]?.version).toBe(1);
  expect(result.claimRevisions[0]?.snapshot.evidences[0]?.id).toBe("evid_a");
  expect(result.coverageDelta).toEqual([
    { path: "src/a.ts", before: "pending", after: "covered" },
  ]);
  expect(result.fileProgress).toEqual({
    total: 3,
    covered: 1,
    acknowledged: 1,
    pending: 1,
    pendingFiles: ["src/b.ts"],
  });
});

test("invalid status is rejected atomically", () => {
  const state = emptyState();
  const before = structuredClone(state);
  const result = reduceClaimAdd(
    state,
    {
      claimId: "claim_a",
      threadId: "thread_core",
      title: "Cover A",
      importance: "important",
      workStatus: "done",
      before: "A was not covered",
      after: "A is covered",
      evidences: [
        {
          id: "evid_a",
          filePath: "src/a.ts",
          startLine: 10,
          endLine: 12,
          change: "Cover A",
        },
      ],
    } as never,
    context(),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.state).toBe(state);
  expect(result.issues.map((issue) => issue.code)).toContain("INVALID_STATUS");
  expect(state).toEqual(before);
  expect(result.events).toEqual([]);
  expect(result.claimRevisions).toEqual([]);
});

test("out-of-range evidence is rejected without mutating state", () => {
  const state = emptyState();
  const result = reduceClaimAdd(
    state,
    {
      claimId: "claim_a",
      threadId: "thread_core",
      title: "Cover A",
      importance: "important",
      before: "A was not covered",
      after: "A is covered",
      evidences: [
        {
          id: "evid_a",
          filePath: "src/a.ts",
          startLine: 100,
          endLine: 101,
          change: "Cover A far away",
        },
      ],
    },
    context(),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues[0]?.code).toBe("EVIDENCE_OUT_OF_RANGE");
  expect(result.state).toBe(state);
  expect(state.claims).toEqual([]);
  expect(state.files[0]?.coverageStatus).toBe("pending");
});

test("evidence add and remove recompute coverage and append revisions", () => {
  const withClaim = addClaim(emptyState());
  const added = reduceEvidenceAdd(
    withClaim,
    {
      actor: "agent",
      claimId: "claim_a",
      evidence: {
        id: "evid_b",
        filePath: "src/b.ts",
        startLine: 20,
        endLine: 22,
        change: "Cover B",
      },
    },
    context(LATER),
  );

  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(added.coverageDelta).toEqual([
    { path: "src/b.ts", before: "pending", after: "covered" },
  ]);
  expect(added.state.claimHistory.map((revision) => revision.version)).toEqual([
    1, 2,
  ]);
  expect(added.fileProgress.pendingFiles).toEqual([]);

  const removed = reduceEvidenceRemove(
    added.state,
    { actor: "agent", claimId: "claim_a", evidenceId: "evid_b" },
    context(LATER),
  );

  expect(removed.ok).toBe(true);
  if (!removed.ok) return;
  expect(removed.coverageDelta).toEqual([
    { path: "src/b.ts", before: "covered", after: "pending" },
  ]);
  expect(removed.state.claimHistory.map((revision) => revision.version)).toEqual([
    1, 2, 3,
  ]);
  expect(removed.fileProgress.pendingFiles).toEqual(["src/b.ts"]);
});

test("file acknowledgement requires a reason and covered files stay covered", () => {
  const withClaim = addClaim(emptyState());
  const invalid = reduceFileAcknowledge(
    withClaim,
    { path: "src/b.ts", reason: " " },
    context(),
  );
  expect(invalid.ok).toBe(false);
  if (invalid.ok) return;
  expect(invalid.state).toBe(withClaim);
  expect(withClaim.files.find((file) => file.path === "src/b.ts")?.coverageStatus)
    .toBe("pending");

  const coveredAcknowledged = reduceFileAcknowledge(
    withClaim,
    { path: "src/a.ts", reason: "Reviewed manually" },
    context(),
  );
  expect(coveredAcknowledged.ok).toBe(true);
  if (!coveredAcknowledged.ok) return;
  const file = coveredAcknowledged.state.files.find(
    (entry) => entry.path === "src/a.ts",
  );
  expect(file?.coverageStatus).toBe("covered");
  expect(file?.acknowledgementReason).toBe("Reviewed manually");
  expect(coveredAcknowledged.coverageDelta).toEqual([]);

  const acknowledged = reduceFileAcknowledge(
    coveredAcknowledged.state,
    { path: "src/b.ts", reason: "Generated snapshot update" },
    context(),
  );
  expect(acknowledged.ok).toBe(true);
  if (!acknowledged.ok) return;
  expect(acknowledged.fileProgress.pendingFiles).toEqual([]);
});

test("blocked and superseded requirements reject edits atomically", () => {
  const withClaim = addClaim(emptyState());
  const blocked = reduceClaimEdit(
    withClaim,
    { claimId: "claim_a", workStatus: "blocked" },
    context(),
  );
  expect(blocked.ok).toBe(false);
  if (blocked.ok) return;
  expect(blocked.state).toBe(withClaim);
  expect(blocked.issues.map((issue) => issue.code)).toContain(
    "BLOCKED_REASON_REQUIRED",
  );

  const blockedWithReason = reduceClaimEdit(
    withClaim,
    {
      claimId: "claim_a",
      workStatus: "blocked",
      blockedReason: "Needs product answer",
    },
    context(LATER),
  );
  expect(blockedWithReason.ok).toBe(true);
  if (!blockedWithReason.ok) return;
  expect(blockedWithReason.events[0]?.type).toBe("claim_status_changed");
  expect(blockedWithReason.claimRevisions[0]?.version).toBe(2);

  const superseded = reduceClaimEdit(
    withClaim,
    { claimId: "claim_a", lifecycleStatus: "superseded" },
    context(),
  );
  expect(superseded.ok).toBe(false);
  if (superseded.ok) return;
  expect(superseded.issues.map((issue) => issue.code)).toContain(
    "SUPERSEDES_REQUIRED",
  );
});

test("review.finalize requires coverage and fresh target", () => {
  const withClaim = addClaim(emptyState());
  const pending = reduceReviewFinalize(
    withClaim,
    { currentTarget: target },
    context(),
  );
  expect(pending.ok).toBe(false);
  if (pending.ok) return;
  expect(pending.issues.map((issue) => issue.code)).toContain("FILE_NOT_COVERED");

  const acknowledged = reduceFileAcknowledge(
    withClaim,
    { path: "src/b.ts", reason: "Generated snapshot update" },
    context(),
  );
  expect(acknowledged.ok).toBe(true);
  if (!acknowledged.ok) return;

  const stale = reduceReviewFinalize(
    acknowledged.state,
    {
      currentTarget: {
        mode: "committed",
        repoKey: "repo",
        baseCommit: "base",
        currentCommit: "other",
      },
    },
    context(),
  );
  expect(stale.ok).toBe(false);
  if (stale.ok) return;
  expect(stale.issues.map((issue) => issue.code)).toContain("STALE_REVIEW");
  expect(stale.state).toBe(acknowledged.state);

  const finalized = reduceReviewFinalize(
    acknowledged.state,
    { currentTarget: target },
    context(LATER),
  );
  expect(finalized.ok).toBe(true);
  if (!finalized.ok) return;
  expect(finalized.events[0]?.type).toBe("review_finalized");
  expect(finalized.fileProgress).toEqual({
    total: 3,
    covered: 1,
    acknowledged: 2,
    pending: 0,
    pendingFiles: [],
  });
});
