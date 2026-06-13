import { expect, test } from "bun:test";

import {
  checkEvidenceSpans,
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
  expect(issues[0]?.fix).toContain("nl -ba -- src/foo.ts");
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
