import { expect, test } from "bun:test";

import {
  checkEvidenceSpans,
  validateApplyPayload,
  validateWorktreeApplyPayload,
  type AgentApplyPayload,
  type ClaimStatus,
  type ValidationPacket,
} from "../src/cli/apply-validation";

function packet(): ValidationPacket {
  return {
    changedFiles: [
      { path: "src/foo.ts", summarized: false },
      { path: "bun.lock", summarized: true },
    ],
    touchedRanges: [
      { filePath: "src/foo.ts", ranges: [{ startLine: 45, endLine: 52 }] },
    ],
  };
}

function payload(
  evidence: { filePath: string; startLine: number; endLine: number },
  agentStatus: ClaimStatus = "new",
): AgentApplyPayload {
  return {
    packetId: "p",
    sessionId: "s",
    revisionId: "r",
    gitFingerprint: "g",
    files: [],
    threads: [
      {
        id: "thread_a",
        title: "Thread A",
        claims: [
          {
            id: "claim_a",
            threadId: "thread_a",
            agentStatus,
            evidences: [{ ...evidence, change: "do thing" }],
          },
        ],
      },
    ],
  };
}

test("intersecting span passes", () => {
  const issues = checkEvidenceSpans(
    packet(),
    payload({ filePath: "src/foo.ts", startLine: 47, endLine: 50 }),
  );
  expect(issues).toEqual([]);
});

test("span within tolerance passes", () => {
  const issues = checkEvidenceSpans(
    packet(),
    payload({ filePath: "src/foo.ts", startLine: 53, endLine: 55 }),
  );
  expect(issues).toEqual([]);
});

test("span outside tolerance is rejected and lists the valid ranges", () => {
  const issues = checkEvidenceSpans(
    packet(),
    payload({ filePath: "src/foo.ts", startLine: 120, endLine: 140 }),
  );
  expect(issues).toHaveLength(1);
  expect(issues[0]?.code).toBe("evidence_out_of_range");
  expect(issues[0]?.fix).toContain("120-140");
  expect(issues[0]?.fix).toContain("Changed line ranges in this file: 45-52");
  expect(issues[0]?.fix).toContain("nl -ba -- 'src/foo.ts'");
});

test("rejection message shell-quotes paths with spaces", () => {
  const spaced: ValidationPacket = {
    changedFiles: [{ path: "src/my file.ts", summarized: false }],
    touchedRanges: [
      { filePath: "src/my file.ts", ranges: [{ startLine: 10, endLine: 12 }] },
    ],
  };
  const issues = checkEvidenceSpans(
    spaced,
    payload({ filePath: "src/my file.ts", startLine: 100, endLine: 105 }),
  );
  expect(issues).toHaveLength(1);
  expect(issues[0]?.fix).toContain("nl -ba -- 'src/my file.ts'");
});

test("deletion-anchored point range keeps a nearby new claim valid", () => {
  // touchedRanges emits a point range (startLine === endLine) for pure-deletion
  // hunks; a new claim anchored within tolerance of that point must pass.
  const deletionPacket: ValidationPacket = {
    changedFiles: [{ path: "src/foo.ts", summarized: false }],
    touchedRanges: [
      { filePath: "src/foo.ts", ranges: [{ startLine: 88, endLine: 88 }] },
    ],
  };
  const inRange = checkEvidenceSpans(
    deletionPacket,
    payload({ filePath: "src/foo.ts", startLine: 89, endLine: 90 }),
  );
  expect(inRange).toEqual([]);
  const outOfRange = checkEvidenceSpans(
    deletionPacket,
    payload({ filePath: "src/foo.ts", startLine: 200, endLine: 201 }),
  );
  expect(outOfRange).toHaveLength(1);
});

test("non-new claims skip the span check", () => {
  for (const status of ["amended", "evidence_moved", "unchanged"] as const) {
    const issues = checkEvidenceSpans(
      packet(),
      payload({ filePath: "src/foo.ts", startLine: 900, endLine: 905 }, status),
    );
    expect(issues).toEqual([]);
  }
});

test("summarized files are skipped", () => {
  const issues = checkEvidenceSpans(
    packet(),
    payload({ filePath: "bun.lock", startLine: 900, endLine: 905 }),
  );
  expect(issues).toEqual([]);
});

test("files absent from touchedRanges are skipped", () => {
  const issues = checkEvidenceSpans(
    packet(),
    payload({ filePath: "src/other.ts", startLine: 900, endLine: 905 }),
  );
  expect(issues).toEqual([]);
});

test("packets without touchedRanges skip the check (backward compat)", () => {
  const legacy: ValidationPacket = { changedFiles: [{ path: "src/foo.ts" }] };
  const issues = checkEvidenceSpans(
    legacy,
    payload({ filePath: "src/foo.ts", startLine: 900, endLine: 905 }),
  );
  expect(issues).toEqual([]);
});

const baseApplyInput = {
  packetId: "p1",
  sessionId: "s1",
  revisionId: "r1",
  gitFingerprint: "g1",
  files: [],
  threads: [],
};

const baseWorktreeInput = {
  packetId: "p1",
  sessionId: "s1",
  worktreeReviewId: "wtr1",
  worktreeHash: "h1",
  gitHead: "c1",
  files: [],
  threads: [],
};

const noKnownClaims = { knownClaimIds: new Set<string>() };

test("validateApplyPayload passes summary through to returned payload", () => {
  const result = validateApplyPayload(
    { ...baseApplyInput, summary: "Agent-written description." },
    noKnownClaims,
  );
  expect(result.issues).toEqual([]);
  expect(result.payload?.summary).toBe("Agent-written description.");
});

test("validateApplyPayload omits summary when absent", () => {
  const result = validateApplyPayload(baseApplyInput, noKnownClaims);
  expect(result.issues).toEqual([]);
  expect(result.payload?.summary).toBeUndefined();
});

test("validateWorktreeApplyPayload passes summary through to returned payload", () => {
  const result = validateWorktreeApplyPayload(
    { ...baseWorktreeInput, summary: "Worktree agent summary." },
    noKnownClaims,
  );
  expect(result.issues).toEqual([]);
  expect(result.payload?.summary).toBe("Worktree agent summary.");
});

test("validateWorktreeApplyPayload omits summary when absent", () => {
  const result = validateWorktreeApplyPayload(baseWorktreeInput, noKnownClaims);
  expect(result.issues).toEqual([]);
  expect(result.payload?.summary).toBeUndefined();
});
