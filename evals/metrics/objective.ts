import type { EvalCaseResult } from "../harness/types";

export type ObjectiveMetricInput = {
  fixture: string;
  agent: string;
  transcript: string;
  exitCode: number;
  wallClockMs: number;
  draftPath: string;
  expectedCoveredFiles: string[];
};

export async function objectiveMetrics(input: ObjectiveMetricInput) {
  const payload = await Bun.file(input.draftPath).json();
  return objectiveMetricsFromPayload(input, payload);
}

function objectiveMetricsFromPayload(
  input: ObjectiveMetricInput,
  payload: unknown,
): EvalCaseResult {
  const errorHistogram = rejectionHistogram(input.transcript);
  const schemaErrorCount = Object.values(errorHistogram).reduce(
    (sum, count) => sum + count,
    0,
  );
  const coveredFiles = coveredFileSet(payload);
  const expectedCovered = input.expectedCoveredFiles.filter((file) =>
    coveredFiles.has(file),
  ).length;
  return {
    fixture: input.fixture,
    agent: input.agent,
    applyAttempts: 1,
    firstAttemptApplySuccess: input.exitCode === 0,
    applyEventuallySucceeded: input.exitCode === 0,
    wallClockMs: input.wallClockMs,
    schemaErrorCount,
    errorHistogram,
    fileCoverage: input.expectedCoveredFiles.length
      ? expectedCovered / input.expectedCoveredFiles.length
      : 1,
    acknowledgeRate: acknowledgeRate(payload),
    claimCount: claimCount(payload),
  };
}

function rejectionHistogram(transcript: string) {
  const histogram: Record<string, number> = {};
  const matches = transcript.matchAll(/"code":\s*"([^"]+)"/g);
  for (const match of matches) {
    const code = match[1];
    if (!code) continue;
    histogram[code] = (histogram[code] ?? 0) + 1;
  }
  return histogram;
}

function coveredFileSet(payload: unknown) {
  const covered = new Set<string>();
  if (!isRecord(payload)) return covered;
  if (Array.isArray(payload.files)) {
    for (const file of payload.files) {
      if (!isRecord(file)) continue;
      if (typeof file.path === "string" && file.disposition === "acknowledged") {
        covered.add(file.path);
      }
    }
  }
  if (Array.isArray(payload.threads)) {
    for (const thread of payload.threads) {
      if (!isRecord(thread) || !Array.isArray(thread.claims)) continue;
      for (const claim of thread.claims) {
        if (!isRecord(claim) || !Array.isArray(claim.evidences)) continue;
        for (const evidence of claim.evidences) {
          if (isRecord(evidence) && typeof evidence.filePath === "string") {
            covered.add(evidence.filePath);
          }
        }
      }
    }
  }
  return covered;
}

function acknowledgeRate(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.files) || payload.files.length === 0) {
    return 0;
  }
  const acknowledged = payload.files.filter(
    (file) => isRecord(file) && file.disposition === "acknowledged",
  ).length;
  return acknowledged / payload.files.length;
}

function claimCount(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.threads)) return 0;
  return payload.threads.reduce((sum, thread) => {
    if (!isRecord(thread) || !Array.isArray(thread.claims)) return sum;
    return sum + thread.claims.length;
  }, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
