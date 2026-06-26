export const REVIEW_SCHEMA_VERSION = 3 as const;

export type ReviewMode = "committed" | "uncommitted";

export type ReviewTarget =
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

export type ReviewLookup =
  | { reviewId: string }
  | { diff: string }
  | { base: string; head: string }
  | { current: true };

export type ReviewFileState = {
  path: string;
  additions: number;
  deletions: number;
  summarized: boolean;
  coverageStatus: "pending" | "covered" | "acknowledged";
  acknowledgementReason?: string;
};

export type ReviewFileCoverageStatus = ReviewFileState["coverageStatus"];

export type ReviewFileProgress = {
  total: number;
  covered: number;
  acknowledged: number;
  pending: number;
  pendingFiles: string[];
};

export type ReviewThreadState = {
  id: string;
  title: string;
  summary?: string;
  order: number;
};

export type ClaimLifecycleStatus = "active" | "invalidated" | "superseded";
export type ClaimWorkStatus = "pending" | "in_progress" | "complete" | "blocked";
export type ClaimImportance = "critical" | "important" | "minor" | "noise";
export type HumanStatus = "unreviewed" | "accepted";
export type ReviewActor = "agent" | "subagent" | "human" | "system";

export type ReviewClaimState = {
  id: string;
  threadId: string;
  title: string;
  importance: ClaimImportance;
  lifecycleStatus: ClaimLifecycleStatus;
  workStatus: ClaimWorkStatus;
  humanStatus: HumanStatus;
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

export type ReviewClaimRevision = {
  id: string;
  claimId: string;
  version: number;
  snapshot: ReviewClaimState;
  eventId: string;
  actor: ReviewActor;
  createdAt: string;
};

export type ReviewEvidenceState = {
  id: string;
  claimId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  change: string;
  symbol?: string;
  fingerprint?: string;
};

export type ReviewEvent = {
  id: string;
  type:
    | "claim_added"
    | "claim_edited"
    | "claim_status_changed"
    | "evidence_added"
    | "evidence_removed"
    | "file_acknowledged"
    | "review_finalized";
  actor: ReviewActor;
  claimId?: string;
  filePath?: string;
  summary: string;
  createdAt: string;
};

export type ReviewEventType = ReviewEvent["type"];

export type ReviewState = {
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
  finalizedAt?: string;
};

export type TouchedRange = {
  filePath: string;
  ranges: Array<{ startLine: number; endLine: number }>;
};

export type ReviewContext = {
  reviewId: string;
  sessionId: string;
  target: ReviewTarget;
  sourceReviewId?: string;
  goal: string | null;
  changedFiles: Array<{
    path: string;
    additions: number;
    deletions: number;
    summarized: boolean;
  }>;
  touchedSnippets: Array<unknown>;
  touchedRanges: TouchedRange[];
  safeInspectionCommands: string[];
  annotatedDiffPath?: string;
  diffArtifactPath?: string;
  skipped?: string[];
};

export const VALID_CLAIM_IMPORTANCES = [
  "critical",
  "important",
  "minor",
  "noise",
] as const satisfies ClaimImportance[];

export const VALID_LIFECYCLE_STATUSES = [
  "active",
  "invalidated",
  "superseded",
] as const satisfies ClaimLifecycleStatus[];

export const VALID_WORK_STATUSES = [
  "pending",
  "in_progress",
  "complete",
  "blocked",
] as const satisfies ClaimWorkStatus[];

export const VALID_HUMAN_STATUSES = [
  "unreviewed",
  "accepted",
] as const satisfies HumanStatus[];

export const REVIEW_ACTORS = [
  "agent",
  "subagent",
  "human",
  "system",
] as const satisfies ReviewActor[];

export const CLAIM_IMPORTANCES = VALID_CLAIM_IMPORTANCES;
export const CLAIM_LIFECYCLE_STATUSES = VALID_LIFECYCLE_STATUSES;
export const CLAIM_WORK_STATUSES = VALID_WORK_STATUSES;
export const HUMAN_STATUSES = VALID_HUMAN_STATUSES;

export function emptyFileProgress(): ReviewFileProgress {
  return { total: 0, covered: 0, acknowledged: 0, pending: 0, pendingFiles: [] };
}

export function deriveFileProgress(
  files: Pick<ReviewFileState, "path" | "coverageStatus">[],
): ReviewFileProgress {
  const progress = emptyFileProgress();
  progress.total = files.length;
  for (const file of files) {
    if (file.coverageStatus === "covered") {
      progress.covered += 1;
    } else if (file.coverageStatus === "acknowledged") {
      progress.acknowledged += 1;
    } else {
      progress.pending += 1;
      progress.pendingFiles.push(file.path);
    }
  }
  progress.pendingFiles.sort();
  return progress;
}

export type CreateReviewStateInput = {
  reviewId: string;
  sessionId: string;
  target: ReviewTarget;
  sourceReviewId?: string;
  branchLabels?: string[];
  goal?: string | null;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    summarized: boolean;
    acknowledgementReason?: string;
    coverageStatus?: ReviewFileCoverageStatus;
  }>;
  createdAt?: string;
  updatedAt?: string;
  now?: string;
};

export function createReviewState(input: CreateReviewStateInput): ReviewState {
  const now = input.createdAt ?? input.now ?? new Date().toISOString();
  const files = input.files.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    summarized: file.summarized,
    coverageStatus:
      file.coverageStatus ??
      (file.acknowledgementReason ? "acknowledged" : "pending"),
    ...(file.acknowledgementReason
      ? { acknowledgementReason: file.acknowledgementReason.trim() }
      : {}),
  })) satisfies ReviewFileState[];
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    reviewId: input.reviewId,
    sessionId: input.sessionId,
    target: input.target,
    ...(input.sourceReviewId ? { sourceReviewId: input.sourceReviewId } : {}),
    branchLabels: input.branchLabels ?? [],
    goal: input.goal ?? null,
    files,
    fileProgress: deriveFileProgress(files),
    threads: [],
    claims: [],
    claimHistory: [],
    events: [],
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
  };
}

export function cloneReviewState(state: ReviewState): ReviewState {
  return structuredClone(state);
}

export function cloneReviewClaim(claim: ReviewClaimState): ReviewClaimState {
  return structuredClone(claim);
}

export function isClaimLifecycleStatus(
  value: unknown,
): value is ClaimLifecycleStatus {
  return isOneOf(value, CLAIM_LIFECYCLE_STATUSES);
}

export function isClaimWorkStatus(value: unknown): value is ClaimWorkStatus {
  return isOneOf(value, CLAIM_WORK_STATUSES);
}

export function isClaimImportance(value: unknown): value is ClaimImportance {
  return isOneOf(value, CLAIM_IMPORTANCES);
}

export function isHumanStatus(value: unknown): value is HumanStatus {
  return isOneOf(value, HUMAN_STATUSES);
}

export function isReviewActor(value: unknown): value is ReviewActor {
  return isOneOf(value, REVIEW_ACTORS);
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}
