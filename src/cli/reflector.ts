import {
  CLAIM_IMPORTANCES,
  CLAIM_LIFECYCLE_STATUSES,
  CLAIM_WORK_STATUSES,
  HUMAN_STATUSES,
  cloneReviewClaim,
  cloneReviewState,
  deriveFileProgress,
  isClaimImportance,
  isClaimLifecycleStatus,
  isClaimWorkStatus,
  isHumanStatus,
  isReviewActor,
  type ClaimImportance,
  type ClaimLifecycleStatus,
  type ClaimWorkStatus,
  type HumanStatus,
  type ReviewActor,
  type ReviewClaimRevision,
  type ReviewClaimState,
  type ReviewEvent,
  type ReviewEventType,
  type ReviewEvidenceState,
  type ReviewFileCoverageStatus,
  type ReviewFileProgress,
  type ReviewFileState,
  type ReviewState,
  type ReviewTarget,
} from "./review-state";

const MAX_CLAIMS_PER_REVIEW = 20_000;
const MAX_EVIDENCES_PER_CLAIM = 50;
const MAX_ID_CHARS = 160;
const MAX_TITLE_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_BEHAVIOR_COPY_CHARS = 4_000;
const MAX_EVIDENCE_CHANGE_CHARS = 1_000;
const MAX_FILE_PATH_CHARS = 1_000;
const MAX_OPTIONAL_LABEL_CHARS = 1_000;
const MAX_ACKNOWLEDGEMENT_REASON_CHARS = 4_000;
const MAX_EVIDENCE_LINE = 1_000_000;
const MAX_EVIDENCE_SPAN_LINES = 5_000;
const EVIDENCE_SPAN_TOLERANCE = 3;

export type ReviewTouchedRange = {
  startLine: number;
  endLine: number;
};

export type ReviewTouchedRangeEntry = {
  filePath: string;
  ranges: ReviewTouchedRange[];
};

export type ReviewFreshnessInput = {
  isFresh: boolean;
  reason?: string;
};

export type ReviewValidationContext = {
  touchedRanges?: ReviewTouchedRangeEntry[];
};

export type ReflectorApplyOptions = ReviewValidationContext & {
  now?: string | (() => string);
  idFactory?: (
    kind: ReflectorGeneratedIdKind,
    state: ReviewState,
  ) => string;
};

export type ReflectorGeneratedIdKind =
  | "claim"
  | "evidence"
  | "event"
  | "claimRevision";

export type EvidenceInput = {
  id?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  change: string;
  symbol?: string;
  fingerprint?: string;
};

export type ClaimAddInput = {
  actor?: ReviewActor;
  claimId?: string;
  threadId: string;
  threadTitle?: string;
  threadSummary?: string;
  title: string;
  importance: ClaimImportance;
  lifecycleStatus?: ClaimLifecycleStatus;
  workStatus?: ClaimWorkStatus;
  humanStatus?: HumanStatus;
  before: string | null;
  after: string | null;
  description?: string;
  evidences: EvidenceInput[];
  assignee?: string;
  supersedesClaimId?: string;
  blockedReason?: string;
  order?: number;
};

export type ClaimEditInput = {
  actor?: ReviewActor;
  claimId: string;
  threadId?: string;
  threadTitle?: string;
  threadSummary?: string;
  title?: string;
  importance?: ClaimImportance;
  lifecycleStatus?: ClaimLifecycleStatus;
  workStatus?: ClaimWorkStatus;
  humanStatus?: HumanStatus;
  before?: string | null;
  after?: string | null;
  description?: string | null;
  assignee?: string | null;
  supersedesClaimId?: string | null;
  blockedReason?: string | null;
};

export type EvidenceAddInput = {
  actor?: ReviewActor;
  claimId: string;
  evidence: EvidenceInput;
};

export type EvidenceRemoveInput = {
  actor?: ReviewActor;
  claimId: string;
  evidenceId: string;
};

export type FileAcknowledgeInput = {
  actor?: ReviewActor;
  path: string;
  reason: string;
};

export type ReviewFinalizeInput = {
  actor?: ReviewActor;
  currentTarget?: ReviewTarget;
  freshness?: ReviewFreshnessInput;
};

export type ReflectorCommand =
  | { type: "claim.add"; input: ClaimAddInput }
  | { type: "claim.edit"; input: ClaimEditInput }
  | { type: "evidence.add"; input: EvidenceAddInput }
  | { type: "evidence.remove"; input: EvidenceRemoveInput }
  | { type: "file.acknowledge"; input: FileAcknowledgeInput }
  | { type: "review.finalize"; input: ReviewFinalizeInput };

export type ReflectorIssueCode =
  | "BLOCKED_REASON_REQUIRED"
  | "CLAIM_NOT_FOUND"
  | "DUPLICATE_ID"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_OUT_OF_RANGE"
  | "FILE_NOT_COVERED"
  | "INVALID_EVIDENCE"
  | "INVALID_FIELD"
  | "INVALID_ID"
  | "INVALID_STATUS"
  | "MISSING_FIELD"
  | "NO_CHANGES"
  | "STALE_REVIEW"
  | "SUPERSEDES_CLAIM_NOT_FOUND"
  | "SUPERSEDES_REQUIRED"
  | "THREAD_NOT_FOUND"
  | "UNKNOWN_FILE";

export type ReflectorIssue = {
  code: ReflectorIssueCode;
  message: string;
  field?: string;
  path?: string;
  claimId?: string;
  evidenceId?: string;
  value?: unknown;
  fix?: string;
};

export type CoverageDelta = {
  path: string;
  before: ReviewFileState["coverageStatus"];
  after: ReviewFileState["coverageStatus"];
};

export type ReflectorSuccessResult = {
  ok: true;
  state: ReviewState;
  events: ReviewEvent[];
  claimRevisions: ReviewClaimRevision[];
  coverageDelta: CoverageDelta[];
  fileProgress: ReviewFileProgress;
};

export type ReflectorFailureResult = {
  ok: false;
  state: ReviewState;
  issues: ReflectorIssue[];
  events: ReviewEvent[];
  claimRevisions: ReviewClaimRevision[];
  coverageDelta: CoverageDelta[];
  fileProgress: ReviewFileProgress;
};

export type ReflectorResult = ReflectorSuccessResult | ReflectorFailureResult;

export class ReflectorError extends Error {
  issues: ReflectorIssue[];

  constructor(issues: ReflectorIssue[]) {
    super("Reflector command rejected.");
    this.name = "ReflectorError";
    this.issues = issues;
  }
}

export function applyReflectorCommand(
  state: ReviewState,
  command: ReflectorCommand,
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  switch (command.type) {
    case "claim.add":
      return reduceClaimAdd(state, command.input, options);
    case "claim.edit":
      return reduceClaimEdit(state, command.input, options);
    case "evidence.add":
      return reduceEvidenceAdd(state, command.input, options);
    case "evidence.remove":
      return reduceEvidenceRemove(state, command.input, options);
    case "file.acknowledge":
      return reduceFileAcknowledge(state, command.input, options);
    case "review.finalize":
      return reduceReviewFinalize(state, command.input, options);
  }
}

export function reflectReviewCommand(
  state: ReviewState,
  command: ReflectorCommand,
  options: ReflectorApplyOptions = {},
): ReflectorSuccessResult {
  const result = applyReflectorCommand(state, command, options);
  if (!result.ok) throw new ReflectorError(result.issues);
  return result;
}

export function reduceClaimAdd(
  state: ReviewState,
  input: ClaimAddInput,
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  const issues: ReflectorIssue[] = [];
  const actor = readActor(input.actor, "actor", issues);
  const now = readNow(options);
  const claimId =
    readOptionalPublicId(input.claimId, "claimId", issues) ??
    nextGeneratedId("claim", state, options, claimIds(state));

  if (state.claims.some((claim) => claim.id === claimId)) {
    issues.push({
      code: "DUPLICATE_ID",
      field: "claimId",
      claimId,
      message: `Claim "${claimId}" already exists.`,
      fix: "Use a new claim id, or edit the existing claim.",
    });
  }

  if (state.claims.length >= MAX_CLAIMS_PER_REVIEW) {
    issues.push({
      code: "INVALID_FIELD",
      field: "claims",
      value: state.claims.length,
      message: `Reviews may contain at most ${MAX_CLAIMS_PER_REVIEW} claims.`,
    });
  }

  const threadId = readPublicId(input.threadId, "threadId", issues);
  const threadTitle = readOptionalText(
    input.threadTitle,
    "threadTitle",
    MAX_TITLE_CHARS,
    issues,
  );
  const threadSummary = readOptionalText(
    input.threadSummary,
    "threadSummary",
    MAX_SUMMARY_CHARS,
    issues,
  );
  const title = readRequiredText(input.title, "title", MAX_TITLE_CHARS, issues);
  const importance = readImportance(input.importance, "importance", issues);
  const lifecycleStatus = readLifecycleStatus(
    input.lifecycleStatus ?? "active",
    "lifecycleStatus",
    issues,
  );
  const workStatus = readWorkStatus(
    input.workStatus ?? "pending",
    "workStatus",
    issues,
  );
  const humanStatus = readHumanStatus(
    input.humanStatus ?? "unreviewed",
    "humanStatus",
    issues,
  );
  const before = readRequiredCopy(input.before, "before", issues);
  const after = readRequiredCopy(input.after, "after", issues);
  const description = readOptionalText(
    input.description,
    "description",
    MAX_DESCRIPTION_CHARS,
    issues,
  );
  const assignee = readOptionalText(
    input.assignee,
    "assignee",
    MAX_OPTIONAL_LABEL_CHARS,
    issues,
  );
  const blockedReason = readOptionalText(
    input.blockedReason,
    "blockedReason",
    MAX_DESCRIPTION_CHARS,
    issues,
  );
  const supersedesClaimId = readOptionalPublicId(
    input.supersedesClaimId,
    "supersedesClaimId",
    issues,
  );
  const order =
    input.order === undefined
      ? nextClaimOrder(state)
      : readNonNegativeInteger(input.order, "order", issues);
  const evidences = readEvidenceInputs(
    input.evidences,
    state,
    claimId,
    "evidences",
    options,
    issues,
  );

  if (Array.isArray(input.evidences) && input.evidences.length === 0) {
    issues.push({
      code: "MISSING_FIELD",
      field: "evidences",
      message: "claim.add requires at least one evidence span.",
      fix: "Add an evidence span, or acknowledge the file separately.",
    });
  }

  if (
    actor === undefined ||
    threadId === undefined ||
    threadTitle === undefined ||
    threadSummary === undefined ||
    title === undefined ||
    importance === undefined ||
    lifecycleStatus === undefined ||
    workStatus === undefined ||
    humanStatus === undefined ||
    before === undefined ||
    after === undefined ||
    description === undefined ||
    assignee === undefined ||
    blockedReason === undefined ||
    order === undefined ||
    evidences === undefined ||
    issues.length > 0
  ) {
    return failure(state, issues);
  }

  const claim: ReviewClaimState = {
    id: claimId,
    threadId,
    title,
    importance,
    lifecycleStatus,
    workStatus,
    humanStatus,
    before,
    after,
    ...(description ? { description } : {}),
    evidences,
    ...(assignee ? { assignee } : {}),
    ...(supersedesClaimId ? { supersedesClaimId } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    order,
    createdAt: now,
    updatedAt: now,
  };

  validateClaimConsistency(claim, state, "claim", issues);
  if (issues.length > 0) return failure(state, issues);

  const next = cloneReviewState(state);
  upsertThread(next, {
    id: threadId,
    title: threadTitle || threadId,
    summary: threadSummary,
  });
  next.claims.push(claim);
  const coverageDelta = recomputeFileCoverage(next, options);
  const event = appendEvent(next, {
    type: "claim_added",
    actor,
    claimId,
    summary: `Added claim "${title}".`,
    createdAt: now,
  }, options);
  const revision = appendClaimRevision(next, claim, event.id, actor, now, options);
  next.updatedAt = now;

  return success(next, [event], [revision], coverageDelta);
}

export function reduceClaimEdit(
  state: ReviewState,
  input: ClaimEditInput,
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  const issues: ReflectorIssue[] = [];
  const actor = readActor(input.actor, "actor", issues);
  const now = readNow(options);
  const claimId = readPublicId(input.claimId, "claimId", issues);
  const existing = claimId
    ? state.claims.find((claim) => claim.id === claimId)
    : undefined;
  if (claimId && !existing) {
    issues.push({
      code: "CLAIM_NOT_FOUND",
      field: "claimId",
      claimId,
      message: `Claim "${claimId}" was not found.`,
      fix: "Run claim list/show and retry with an existing claim id.",
    });
  }
  if (actor === undefined || claimId === undefined || existing === undefined) {
    return failure(state, issues);
  }

  if (!hasAnyEditField(input)) {
    return failure(state, [
      {
        code: "NO_CHANGES",
        field: "input",
        claimId,
        message: "claim.edit needs at least one editable field.",
      },
    ]);
  }

  const candidate = cloneReviewClaim(existing);
  const oldStatusFields = claimStatusSignature(candidate);
  let requestedThreadTitle: string | undefined;
  let requestedThreadSummary: string | undefined;

  if (hasOwn(input, "threadId")) {
    const threadId = readPublicId(input.threadId, "threadId", issues);
    if (threadId !== undefined) candidate.threadId = threadId;
  }
  if (hasOwn(input, "threadTitle")) {
    requestedThreadTitle = readRequiredText(
      input.threadTitle,
      "threadTitle",
      MAX_TITLE_CHARS,
      issues,
    );
  }
  if (hasOwn(input, "threadSummary")) {
    requestedThreadSummary = readOptionalText(
      input.threadSummary,
      "threadSummary",
      MAX_SUMMARY_CHARS,
      issues,
    );
  }
  if (hasOwn(input, "title")) {
    const title = readRequiredText(input.title, "title", MAX_TITLE_CHARS, issues);
    if (title !== undefined) candidate.title = title;
  }
  if (hasOwn(input, "importance")) {
    const importance = readImportance(input.importance, "importance", issues);
    if (importance !== undefined) candidate.importance = importance;
  }
  if (hasOwn(input, "lifecycleStatus")) {
    const lifecycleStatus = readLifecycleStatus(
      input.lifecycleStatus,
      "lifecycleStatus",
      issues,
    );
    if (lifecycleStatus !== undefined) {
      candidate.lifecycleStatus = lifecycleStatus;
    }
  }
  if (hasOwn(input, "workStatus")) {
    const workStatus = readWorkStatus(input.workStatus, "workStatus", issues);
    if (workStatus !== undefined) candidate.workStatus = workStatus;
  }
  if (hasOwn(input, "humanStatus")) {
    const humanStatus = readHumanStatus(input.humanStatus, "humanStatus", issues);
    if (humanStatus !== undefined) candidate.humanStatus = humanStatus;
  }
  if (hasOwn(input, "before")) {
    const before = readRequiredCopy(input.before, "before", issues);
    if (before !== undefined) candidate.before = before;
  }
  if (hasOwn(input, "after")) {
    const after = readRequiredCopy(input.after, "after", issues);
    if (after !== undefined) candidate.after = after;
  }
  if (hasOwn(input, "description")) {
    if (input.description === null) {
      delete candidate.description;
    } else {
      const description = readOptionalText(
        input.description,
        "description",
        MAX_DESCRIPTION_CHARS,
        issues,
      );
      if (description !== undefined) {
        if (description) candidate.description = description;
        else delete candidate.description;
      }
    }
  }
  if (hasOwn(input, "assignee")) {
    if (input.assignee === null) {
      delete candidate.assignee;
    } else {
      const assignee = readOptionalText(
        input.assignee,
        "assignee",
        MAX_OPTIONAL_LABEL_CHARS,
        issues,
      );
      if (assignee !== undefined) {
        if (assignee) candidate.assignee = assignee;
        else delete candidate.assignee;
      }
    }
  }
  if (hasOwn(input, "blockedReason")) {
    if (input.blockedReason === null) {
      delete candidate.blockedReason;
    } else {
      const blockedReason = readOptionalText(
        input.blockedReason,
        "blockedReason",
        MAX_DESCRIPTION_CHARS,
        issues,
      );
      if (blockedReason !== undefined) {
        if (blockedReason) candidate.blockedReason = blockedReason;
        else delete candidate.blockedReason;
      }
    }
  }
  if (hasOwn(input, "supersedesClaimId")) {
    if (input.supersedesClaimId === null) {
      delete candidate.supersedesClaimId;
    } else {
      const supersedesClaimId = readOptionalPublicId(
        input.supersedesClaimId,
        "supersedesClaimId",
        issues,
      );
      if (supersedesClaimId !== undefined) {
        if (supersedesClaimId) {
          candidate.supersedesClaimId = supersedesClaimId;
        } else {
          delete candidate.supersedesClaimId;
        }
      }
    }
  }

  validateClaimConsistency(candidate, state, "claim", issues);
  if (issues.length > 0) return failure(state, issues);

  const snapshotChanged = !claimsEqual(existing, candidate);
  const statusChanged = oldStatusFields !== claimStatusSignature(candidate);
  if (snapshotChanged) candidate.updatedAt = now;

  const next = cloneReviewState(state);
  const claimIndex = next.claims.findIndex((claim) => claim.id === claimId);
  next.claims[claimIndex] = candidate;
  upsertThread(next, {
    id: candidate.threadId,
    title: requestedThreadTitle ?? candidate.threadId,
    summary: requestedThreadSummary,
    onlyIfMissing: requestedThreadTitle === undefined,
  });
  const coverageDelta = recomputeFileCoverage(next, options);
  const event = appendEvent(next, {
    type: statusChanged ? "claim_status_changed" : "claim_edited",
    actor,
    claimId,
    summary: statusChanged
      ? `Changed status for claim "${claimId}".`
      : `Edited claim "${claimId}".`,
    createdAt: now,
  }, options);
  const revisions = snapshotChanged
    ? [appendClaimRevision(next, candidate, event.id, actor, now, options)]
    : [];
  next.updatedAt = now;

  return success(next, [event], revisions, coverageDelta);
}

export function reduceEvidenceAdd(
  state: ReviewState,
  input: EvidenceAddInput,
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  const issues: ReflectorIssue[] = [];
  const actor = readActor(input.actor, "actor", issues);
  const now = readNow(options);
  const claimId = readPublicId(input.claimId, "claimId", issues);
  const existing = claimId
    ? state.claims.find((claim) => claim.id === claimId)
    : undefined;
  if (claimId && !existing) {
    issues.push({
      code: "CLAIM_NOT_FOUND",
      field: "claimId",
      claimId,
      message: `Claim "${claimId}" was not found.`,
    });
  }
  if (existing && existing.evidences.length >= MAX_EVIDENCES_PER_CLAIM) {
    issues.push({
      code: "INVALID_FIELD",
      field: "evidence",
      claimId: existing.id,
      message: `Claims may contain at most ${MAX_EVIDENCES_PER_CLAIM} evidence spans.`,
    });
  }
  if (actor === undefined || claimId === undefined || existing === undefined) {
    return failure(state, issues);
  }

  const evidence = readEvidenceInput(
    input.evidence,
    state,
    claimId,
    "evidence",
    options,
    issues,
    evidenceIds(state),
  );
  if (evidence === undefined) return failure(state, issues);

  const candidate = cloneReviewClaim(existing);
  candidate.evidences.push(evidence);
  validateClaimConsistency(candidate, state, "claim", issues);
  if (issues.length > 0) return failure(state, issues);
  candidate.updatedAt = now;

  const next = cloneReviewState(state);
  const claimIndex = next.claims.findIndex((claim) => claim.id === claimId);
  next.claims[claimIndex] = candidate;
  const coverageDelta = recomputeFileCoverage(next, options);
  const event = appendEvent(next, {
    type: "evidence_added",
    actor,
    claimId,
    filePath: evidence.filePath,
    summary: `Added evidence "${evidence.id}" to claim "${claimId}".`,
    createdAt: now,
  }, options);
  const revision = appendClaimRevision(
    next,
    candidate,
    event.id,
    actor,
    now,
    options,
  );
  next.updatedAt = now;

  return success(next, [event], [revision], coverageDelta);
}

export function reduceEvidenceRemove(
  state: ReviewState,
  input: EvidenceRemoveInput,
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  const issues: ReflectorIssue[] = [];
  const actor = readActor(input.actor, "actor", issues);
  const now = readNow(options);
  const claimId = readPublicId(input.claimId, "claimId", issues);
  const evidenceId = readPublicId(input.evidenceId, "evidenceId", issues);
  const existing = claimId
    ? state.claims.find((claim) => claim.id === claimId)
    : undefined;
  if (claimId && !existing) {
    issues.push({
      code: "CLAIM_NOT_FOUND",
      field: "claimId",
      claimId,
      message: `Claim "${claimId}" was not found.`,
    });
  }
  const evidence = existing?.evidences.find(
    (entry) => entry.id === evidenceId,
  );
  if (existing && evidenceId && !evidence) {
    issues.push({
      code: "EVIDENCE_NOT_FOUND",
      field: "evidenceId",
      claimId: existing.id,
      evidenceId,
      message: `Evidence "${evidenceId}" was not found on claim "${existing.id}".`,
    });
  }
  if (
    actor === undefined ||
    claimId === undefined ||
    evidenceId === undefined ||
    existing === undefined ||
    evidence === undefined
  ) {
    return failure(state, issues);
  }

  const candidate = cloneReviewClaim(existing);
  candidate.evidences = candidate.evidences.filter(
    (entry) => entry.id !== evidenceId,
  );
  validateClaimConsistency(candidate, state, "claim", issues);
  if (issues.length > 0) return failure(state, issues);
  candidate.updatedAt = now;

  const next = cloneReviewState(state);
  const claimIndex = next.claims.findIndex((claim) => claim.id === claimId);
  next.claims[claimIndex] = candidate;
  const coverageDelta = recomputeFileCoverage(next, options);
  const event = appendEvent(next, {
    type: "evidence_removed",
    actor,
    claimId,
    filePath: evidence.filePath,
    summary: `Removed evidence "${evidenceId}" from claim "${claimId}".`,
    createdAt: now,
  }, options);
  const revision = appendClaimRevision(
    next,
    candidate,
    event.id,
    actor,
    now,
    options,
  );
  next.updatedAt = now;

  return success(next, [event], [revision], coverageDelta);
}

export function reduceFileAcknowledge(
  state: ReviewState,
  input: FileAcknowledgeInput,
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  const issues: ReflectorIssue[] = [];
  const actor = readActor(input.actor, "actor", issues);
  const now = readNow(options);
  const path = readRepositoryPath(input.path, "path", issues);
  const reason = readRequiredText(
    input.reason,
    "reason",
    MAX_ACKNOWLEDGEMENT_REASON_CHARS,
    issues,
  );
  if (path && !state.files.some((file) => file.path === path)) {
    issues.push({
      code: "UNKNOWN_FILE",
      field: "path",
      path,
      message: `File "${path}" is not part of this review target.`,
      fix: "Acknowledge only files listed in the current review state.",
    });
  }
  if (actor === undefined || path === undefined || reason === undefined) {
    return failure(state, issues);
  }
  if (issues.length > 0) return failure(state, issues);

  const next = cloneReviewState(state);
  const file = next.files.find((entry) => entry.path === path);
  if (!file) return failure(state, issues);
  file.acknowledgementReason = reason;
  const coverageDelta = recomputeFileCoverage(next, options);
  const event = appendEvent(next, {
    type: "file_acknowledged",
    actor,
    filePath: path,
    summary: `Acknowledged file "${path}".`,
    createdAt: now,
  }, options);
  next.updatedAt = now;

  return success(next, [event], [], coverageDelta);
}

export function reduceReviewFinalize(
  state: ReviewState,
  input: ReviewFinalizeInput = {},
  options: ReflectorApplyOptions = {},
): ReflectorResult {
  const issues: ReflectorIssue[] = [];
  const actor = readActor(input.actor, "actor", issues);
  const now = readNow(options);

  if (input.currentTarget && !reviewTargetsEqual(state.target, input.currentTarget)) {
    issues.push({
      code: "STALE_REVIEW",
      field: "currentTarget",
      message: "The review target no longer matches the current Git target.",
      fix: "Refresh the review context before finalizing.",
    });
  }
  if (input.freshness?.isFresh === false) {
    issues.push({
      code: "STALE_REVIEW",
      field: "freshness",
      message: input.freshness.reason ?? "The review target is stale.",
      fix: "Refresh the review context before finalizing.",
    });
  }
  if (actor === undefined) return failure(state, issues);

  const next = cloneReviewState(state);
  const coverageDelta = recomputeFileCoverage(next, options);
  validateReviewStateForFinalize(next, options, issues);
  for (const path of next.fileProgress.pendingFiles) {
    issues.push({
      code: "FILE_NOT_COVERED",
      path,
      message: `File "${path}" is neither covered by active evidence nor acknowledged.`,
      fix: "Add active claim evidence for this file, or acknowledge it with a reason.",
    });
  }

  if (issues.length > 0) return failure(state, issues);

  const event = appendEvent(next, {
    type: "review_finalized",
    actor,
    summary: "Finalized review.",
    createdAt: now,
  }, options);
  next.updatedAt = now;
  next.finalizedAt = now;

  return success(next, [event], [], coverageDelta);
}

export function recomputeReviewCoverage(
  state: ReviewState,
  context: ReviewValidationContext = {},
): {
  state: ReviewState;
  coverageDelta: CoverageDelta[];
  fileProgress: ReviewFileProgress;
} {
  const next = cloneReviewState(state);
  const coverageDelta = recomputeFileCoverage(next, context);
  return {
    state: next,
    coverageDelta,
    fileProgress: next.fileProgress,
  };
}

export function reviewTargetsEqual(
  left: ReviewTarget,
  right: ReviewTarget,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.repoKey !== right.repoKey) return false;
  if (left.mode === "committed") {
    return (
      right.mode === "committed" &&
      left.baseCommit === right.baseCommit &&
      left.currentCommit === right.currentCommit
    );
  }
  return (
    right.mode === "uncommitted" &&
    left.currentCommit === right.currentCommit &&
    left.worktreeHash === right.worktreeHash
  );
}

function success(
  state: ReviewState,
  events: ReviewEvent[],
  claimRevisions: ReviewClaimRevision[],
  coverageDelta: CoverageDelta[],
): ReflectorSuccessResult {
  return {
    ok: true,
    state,
    events,
    claimRevisions,
    coverageDelta,
    fileProgress: state.fileProgress,
  };
}

function failure(
  state: ReviewState,
  issues: ReflectorIssue[],
): ReflectorFailureResult {
  return {
    ok: false,
    state,
    issues,
    events: [],
    claimRevisions: [],
    coverageDelta: [],
    fileProgress: state.fileProgress,
  };
}

function readEvidenceInputs(
  value: unknown,
  state: ReviewState,
  claimId: string,
  field: string,
  options: ReflectorApplyOptions,
  issues: ReflectorIssue[],
) {
  if (!Array.isArray(value)) {
    issues.push({
      code: value === undefined ? "MISSING_FIELD" : "INVALID_FIELD",
      field,
      value,
      message: `${field} must be an array of evidence spans.`,
    });
    return undefined;
  }
  if (value.length > MAX_EVIDENCES_PER_CLAIM) {
    issues.push({
      code: "INVALID_FIELD",
      field,
      value: value.length,
      message: `Use at most ${MAX_EVIDENCES_PER_CLAIM} evidence spans per claim.`,
    });
  }
  const reserved = evidenceIds(state);
  const evidences: ReviewEvidenceState[] = [];
  value.forEach((entry, index) => {
    const evidence = readEvidenceInput(
      entry,
      state,
      claimId,
      `${field}[${index}]`,
      options,
      issues,
      reserved,
    );
    if (evidence) {
      reserved.add(evidence.id);
      evidences.push(evidence);
    }
  });
  return evidences;
}

function readEvidenceInput(
  value: unknown,
  state: ReviewState,
  claimId: string,
  field: string,
  options: ReflectorApplyOptions,
  issues: ReflectorIssue[],
  reserved: Set<string>,
) {
  if (!isRecord(value)) {
    issues.push({
      code: "INVALID_EVIDENCE",
      field,
      value,
      claimId,
      message: "Evidence must be an object.",
    });
    return undefined;
  }

  const explicitId = readOptionalPublicId(value.id, `${field}.id`, issues);
  const id =
    explicitId ?? nextGeneratedId("evidence", state, options, reserved);
  if (reserved.has(id)) {
    issues.push({
      code: "DUPLICATE_ID",
      field: `${field}.id`,
      claimId,
      evidenceId: id,
      message: `Evidence id "${id}" already exists.`,
    });
  }
  const filePath = readRepositoryPath(
    value.filePath,
    `${field}.filePath`,
    issues,
  );
  const startLine = readEvidenceLine(
    value.startLine,
    `${field}.startLine`,
    issues,
  );
  const endLine = readEvidenceLine(value.endLine, `${field}.endLine`, issues);
  const change = readRequiredText(
    value.change,
    `${field}.change`,
    MAX_EVIDENCE_CHANGE_CHARS,
    issues,
  );
  const symbol = readOptionalText(
    value.symbol,
    `${field}.symbol`,
    MAX_OPTIONAL_LABEL_CHARS,
    issues,
  );
  const fingerprint = readOptionalText(
    value.fingerprint,
    `${field}.fingerprint`,
    MAX_OPTIONAL_LABEL_CHARS,
    issues,
  );

  if (filePath && !state.files.some((file) => file.path === filePath)) {
    issues.push({
      code: "UNKNOWN_FILE",
      field: `${field}.filePath`,
      path: filePath,
      claimId,
      value: filePath,
      message: `Evidence file "${filePath}" is not part of this review target.`,
      fix: "Use a changed file from the review context.",
    });
  }
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    (endLine < startLine ||
      endLine - startLine + 1 > MAX_EVIDENCE_SPAN_LINES)
  ) {
    issues.push({
      code: "INVALID_EVIDENCE",
      field: `${field}.endLine`,
      claimId,
      value: endLine,
      message: `Evidence ranges must be ordered and span at most ${MAX_EVIDENCE_SPAN_LINES} lines.`,
    });
  }

  if (
    filePath === undefined ||
    startLine === undefined ||
    endLine === undefined ||
    change === undefined ||
    symbol === undefined ||
    fingerprint === undefined
  ) {
    return undefined;
  }

  const evidence: ReviewEvidenceState = {
    id,
    claimId,
    filePath,
    startLine,
    endLine,
    change,
    ...(symbol ? { symbol } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
  validateEvidenceTouchedRange(evidence, state, field, issues, options);
  if (issues.some((issue) => issue.field?.startsWith(field))) return undefined;
  return evidence;
}

function validateEvidenceTouchedRange(
  evidence: ReviewEvidenceState,
  state: ReviewState,
  field: string,
  issues: ReflectorIssue[],
  context: ReviewValidationContext,
) {
  const file = state.files.find((entry) => entry.path === evidence.filePath);
  if (!file || file.summarized || !context.touchedRanges) return;
  const touched = context.touchedRanges.find(
    (entry) => entry.filePath === evidence.filePath,
  );
  if (!touched) return;
  const intersects = touched.ranges.some((range) =>
    evidenceIntersectsRange(evidence, range),
  );
  if (intersects) return;
  const rangeList =
    touched.ranges
      .map((range) => `${range.startLine}-${range.endLine}`)
      .join(", ") || "none";
  issues.push({
    code: "EVIDENCE_OUT_OF_RANGE",
    field,
    path: evidence.filePath,
    claimId: evidence.claimId,
    evidenceId: evidence.id,
    message: `Evidence span ${evidence.startLine}-${evidence.endLine} in "${evidence.filePath}" does not touch changed lines.`,
    fix: `Changed line ranges in this file: ${rangeList}. Copy line numbers from the annotated diff, or verify with: nl -ba -- ${shellQuote(evidence.filePath)}.`,
  });
}

function validateClaimConsistency(
  claim: ReviewClaimState,
  state: ReviewState,
  field: string,
  issues: ReflectorIssue[],
) {
  if (claim.workStatus === "blocked" && !hasText(claim.blockedReason)) {
    issues.push({
      code: "BLOCKED_REASON_REQUIRED",
      field: `${field}.blockedReason`,
      claimId: claim.id,
      message: "Blocked claims require blockedReason.",
      fix: "Add a blocked reason, or use a non-blocked work status.",
    });
  }

  if (
    claim.lifecycleStatus === "superseded" &&
    !hasText(claim.supersedesClaimId)
  ) {
    issues.push({
      code: "SUPERSEDES_REQUIRED",
      field: `${field}.supersedesClaimId`,
      claimId: claim.id,
      message: "Superseded claims require supersedesClaimId.",
      fix: "Add the claim id this claim supersedes, or use a different lifecycle status.",
    });
  }

  if (hasText(claim.supersedesClaimId)) {
    if (claim.supersedesClaimId === claim.id) {
      issues.push({
        code: "SUPERSEDES_CLAIM_NOT_FOUND",
        field: `${field}.supersedesClaimId`,
        claimId: claim.id,
        value: claim.supersedesClaimId,
        message: "A claim cannot supersede itself.",
      });
      return;
    }
    if (!state.claims.some((entry) => entry.id === claim.supersedesClaimId)) {
      issues.push({
        code: "SUPERSEDES_CLAIM_NOT_FOUND",
        field: `${field}.supersedesClaimId`,
        claimId: claim.id,
        value: claim.supersedesClaimId,
        message: `Superseded claim "${claim.supersedesClaimId}" was not found.`,
      });
    }
  }
}

function validateReviewStateForFinalize(
  state: ReviewState,
  context: ReviewValidationContext,
  issues: ReflectorIssue[],
) {
  const threadIdSet = new Set<string>();
  const claimIdSet = new Set<string>();
  const evidenceIdSet = new Set<string>();
  const filePaths = new Set(state.files.map((file) => file.path));

  readPublicId(state.reviewId, "reviewId", issues);
  readPublicId(state.sessionId, "sessionId", issues);

  state.files.forEach((file, index) => {
    const field = `files[${index}]`;
    readRepositoryPath(file.path, `${field}.path`, issues);
    readNonNegativeInteger(file.additions, `${field}.additions`, issues);
    readNonNegativeInteger(file.deletions, `${field}.deletions`, issues);
    if (
      file.coverageStatus === "acknowledged" &&
      !hasText(file.acknowledgementReason)
    ) {
      issues.push({
        code: "MISSING_FIELD",
        field: `${field}.acknowledgementReason`,
        path: file.path,
        message: "Acknowledged files require acknowledgementReason.",
      });
    }
  });

  state.threads.forEach((thread, index) => {
    const field = `threads[${index}]`;
    const threadId = readPublicId(thread.id, `${field}.id`, issues);
    readRequiredText(thread.title, `${field}.title`, MAX_TITLE_CHARS, issues);
    readOptionalText(thread.summary, `${field}.summary`, MAX_SUMMARY_CHARS, issues);
    readNonNegativeInteger(thread.order, `${field}.order`, issues);
    if (threadId && threadIdSet.has(threadId)) {
      issues.push({
        code: "DUPLICATE_ID",
        field: `${field}.id`,
        value: threadId,
        message: `Duplicate thread id "${threadId}".`,
      });
    }
    if (threadId) threadIdSet.add(threadId);
  });

  state.claims.forEach((claim, claimIndex) => {
    const field = `claims[${claimIndex}]`;
    const claimId = readPublicId(claim.id, `${field}.id`, issues);
    const threadId = readPublicId(claim.threadId, `${field}.threadId`, issues);
    readRequiredText(claim.title, `${field}.title`, MAX_TITLE_CHARS, issues);
    readImportance(claim.importance, `${field}.importance`, issues);
    readLifecycleStatus(
      claim.lifecycleStatus,
      `${field}.lifecycleStatus`,
      issues,
    );
    readWorkStatus(claim.workStatus, `${field}.workStatus`, issues);
    readHumanStatus(claim.humanStatus, `${field}.humanStatus`, issues);
    readRequiredCopy(claim.before, `${field}.before`, issues);
    readRequiredCopy(claim.after, `${field}.after`, issues);
    readOptionalText(
      claim.description,
      `${field}.description`,
      MAX_DESCRIPTION_CHARS,
      issues,
    );
    readOptionalText(
      claim.assignee,
      `${field}.assignee`,
      MAX_OPTIONAL_LABEL_CHARS,
      issues,
    );
    readOptionalText(
      claim.blockedReason,
      `${field}.blockedReason`,
      MAX_DESCRIPTION_CHARS,
      issues,
    );
    readNonNegativeInteger(claim.order, `${field}.order`, issues);
    validateClaimConsistency(claim, state, field, issues);

    if (claimId && claimIdSet.has(claimId)) {
      issues.push({
        code: "DUPLICATE_ID",
        field: `${field}.id`,
        claimId,
        message: `Duplicate claim id "${claimId}".`,
      });
    }
    if (claimId) claimIdSet.add(claimId);
    if (threadId && !threadIdSet.has(threadId)) {
      issues.push({
        code: "THREAD_NOT_FOUND",
        field: `${field}.threadId`,
        claimId: claim.id,
        value: threadId,
        message: `Thread "${threadId}" was not found for claim "${claim.id}".`,
      });
    }

    if (!Array.isArray(claim.evidences)) {
      issues.push({
        code: "MISSING_FIELD",
        field: `${field}.evidences`,
        claimId: claim.id,
        message: "Claim evidences must be an array.",
      });
      return;
    }
    if (claim.evidences.length > MAX_EVIDENCES_PER_CLAIM) {
      issues.push({
        code: "INVALID_FIELD",
        field: `${field}.evidences`,
        claimId: claim.id,
        value: claim.evidences.length,
        message: `Use at most ${MAX_EVIDENCES_PER_CLAIM} evidence spans per claim.`,
      });
    }
    claim.evidences.forEach((evidence, evidenceIndex) => {
      const evidenceField = `${field}.evidences[${evidenceIndex}]`;
      const evidenceId = readPublicId(
        evidence.id,
        `${evidenceField}.id`,
        issues,
      );
      readPublicId(evidence.claimId, `${evidenceField}.claimId`, issues);
      if (evidence.claimId !== claim.id) {
        issues.push({
          code: "INVALID_EVIDENCE",
          field: `${evidenceField}.claimId`,
          claimId: claim.id,
          evidenceId: evidence.id,
          message: "Evidence claimId must match its parent claim.",
        });
      }
      validateEvidenceState(
        evidence,
        evidenceField,
        filePaths,
        claim.lifecycleStatus === "active" ? context : {},
        state,
        issues,
      );
      if (evidenceId && evidenceIdSet.has(evidenceId)) {
        issues.push({
          code: "DUPLICATE_ID",
          field: `${evidenceField}.id`,
          claimId: claim.id,
          evidenceId,
          message: `Duplicate evidence id "${evidenceId}".`,
        });
      }
      if (evidenceId) evidenceIdSet.add(evidenceId);
    });
  });
}

function validateEvidenceState(
  evidence: ReviewEvidenceState,
  field: string,
  filePaths: Set<string>,
  context: ReviewValidationContext,
  state: ReviewState,
  issues: ReflectorIssue[],
) {
  const filePath = readRepositoryPath(evidence.filePath, `${field}.filePath`, issues);
  const startLine = readEvidenceLine(
    evidence.startLine,
    `${field}.startLine`,
    issues,
  );
  const endLine = readEvidenceLine(evidence.endLine, `${field}.endLine`, issues);
  readRequiredText(
    evidence.change,
    `${field}.change`,
    MAX_EVIDENCE_CHANGE_CHARS,
    issues,
  );
  readOptionalText(
    evidence.symbol,
    `${field}.symbol`,
    MAX_OPTIONAL_LABEL_CHARS,
    issues,
  );
  readOptionalText(
    evidence.fingerprint,
    `${field}.fingerprint`,
    MAX_OPTIONAL_LABEL_CHARS,
    issues,
  );

  if (filePath && !filePaths.has(filePath)) {
    issues.push({
      code: "UNKNOWN_FILE",
      field: `${field}.filePath`,
      path: filePath,
      claimId: evidence.claimId,
      evidenceId: evidence.id,
      message: `Evidence file "${filePath}" is not part of this review target.`,
    });
  }
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    (endLine < startLine ||
      endLine - startLine + 1 > MAX_EVIDENCE_SPAN_LINES)
  ) {
    issues.push({
      code: "INVALID_EVIDENCE",
      field: `${field}.endLine`,
      claimId: evidence.claimId,
      evidenceId: evidence.id,
      message: `Evidence ranges must be ordered and span at most ${MAX_EVIDENCE_SPAN_LINES} lines.`,
    });
  }
  validateEvidenceTouchedRange(evidence, state, field, issues, context);
}

function recomputeFileCoverage(
  state: ReviewState,
  context: ReviewValidationContext,
): CoverageDelta[] {
  const before = new Map<string, ReviewFileCoverageStatus>();
  const filesByPath = new Map<string, ReviewFileState>();
  for (const file of state.files) {
    before.set(file.path, file.coverageStatus);
    filesByPath.set(file.path, file);
  }

  const covered = new Set<string>();
  for (const claim of state.claims) {
    if (claim.lifecycleStatus !== "active") continue;
    for (const evidence of claim.evidences) {
      const file = filesByPath.get(evidence.filePath);
      if (!file) continue;
      if (evidenceCoversFile(evidence, file, context)) covered.add(file.path);
    }
  }

  for (const file of state.files) {
    const acknowledgementReason = file.acknowledgementReason?.trim();
    if (acknowledgementReason) {
      file.acknowledgementReason = acknowledgementReason;
    } else {
      delete file.acknowledgementReason;
    }
    if (covered.has(file.path)) {
      file.coverageStatus = "covered";
    } else if (acknowledgementReason) {
      file.coverageStatus = "acknowledged";
    } else {
      file.coverageStatus = "pending";
    }
  }
  state.fileProgress = deriveFileProgress(state.files);

  return state.files
    .map((file) => ({
      path: file.path,
      before: before.get(file.path) ?? "pending",
      after: file.coverageStatus,
    }))
    .filter((delta) => delta.before !== delta.after);
}

function evidenceCoversFile(
  evidence: ReviewEvidenceState,
  file: ReviewFileState,
  context: ReviewValidationContext,
) {
  if (evidence.filePath !== file.path) return false;
  if (!isSafeRepositoryPath(evidence.filePath)) return false;
  if (!isValidEvidenceLine(evidence.startLine)) return false;
  if (!isValidEvidenceLine(evidence.endLine)) return false;
  if (
    evidence.endLine < evidence.startLine ||
    evidence.endLine - evidence.startLine + 1 > MAX_EVIDENCE_SPAN_LINES
  ) {
    return false;
  }
  if (file.summarized || !context.touchedRanges) return true;
  const touched = context.touchedRanges.find(
    (entry) => entry.filePath === evidence.filePath,
  );
  if (!touched) return true;
  return touched.ranges.some((range) => evidenceIntersectsRange(evidence, range));
}

function evidenceIntersectsRange(
  evidence: Pick<ReviewEvidenceState, "startLine" | "endLine">,
  range: ReviewTouchedRange,
) {
  return (
    evidence.startLine <= range.endLine + EVIDENCE_SPAN_TOLERANCE &&
    evidence.endLine >= range.startLine - EVIDENCE_SPAN_TOLERANCE
  );
}

function appendEvent(
  state: ReviewState,
  event: Omit<ReviewEvent, "id">,
  options: ReflectorApplyOptions,
) {
  const id = nextGeneratedId("event", state, options, eventIds(state));
  const created: ReviewEvent = { id, ...event };
  state.events.push(created);
  return created;
}

function appendClaimRevision(
  state: ReviewState,
  claim: ReviewClaimState,
  eventId: string,
  actor: ReviewActor,
  now: string,
  options: ReflectorApplyOptions,
) {
  const id = nextGeneratedId(
    "claimRevision",
    state,
    options,
    claimRevisionIds(state),
  );
  const version =
    Math.max(
      0,
      ...state.claimHistory
        .filter((revision) => revision.claimId === claim.id)
        .map((revision) => revision.version),
    ) + 1;
  const revision: ReviewClaimRevision = {
    id,
    claimId: claim.id,
    version,
    snapshot: cloneReviewClaim(claim),
    eventId,
    actor,
    createdAt: now,
  };
  state.claimHistory.push(revision);
  return revision;
}

function upsertThread(
  state: ReviewState,
  input: {
    id: string;
    title: string;
    summary?: string;
    onlyIfMissing?: boolean;
  },
) {
  const existing = state.threads.find((thread) => thread.id === input.id);
  if (existing) {
    if (!input.onlyIfMissing) {
      existing.title = input.title;
    }
    if (input.summary !== undefined) {
      if (input.summary) existing.summary = input.summary;
      else delete existing.summary;
    }
    return existing;
  }
  const thread = {
    id: input.id,
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    order:
      Math.max(0, ...state.threads.map((existingThread) => existingThread.order)) +
      1,
  };
  state.threads.push(thread);
  return thread;
}

function hasAnyEditField(input: ClaimEditInput) {
  return [
    "threadId",
    "threadTitle",
    "threadSummary",
    "title",
    "importance",
    "lifecycleStatus",
    "workStatus",
    "humanStatus",
    "before",
    "after",
    "description",
    "assignee",
    "supersedesClaimId",
    "blockedReason",
  ].some((field) => hasOwn(input, field));
}

function readActor(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
): ReviewActor | undefined {
  if (value === undefined) return "agent";
  if (isReviewActor(value)) return value;
  issues.push({
    code: "INVALID_FIELD",
    field,
    value,
    message: `${field} must be one of: agent, subagent, human, system.`,
  });
  return undefined;
}

function readLifecycleStatus(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (isClaimLifecycleStatus(value)) return value;
  issues.push({
    code: value === undefined ? "MISSING_FIELD" : "INVALID_STATUS",
    field,
    value,
    message: `${field} must be one of: ${CLAIM_LIFECYCLE_STATUSES.join(", ")}.`,
  });
  return undefined;
}

function readWorkStatus(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (isClaimWorkStatus(value)) return value;
  issues.push({
    code: value === undefined ? "MISSING_FIELD" : "INVALID_STATUS",
    field,
    value,
    message: `${field} must be one of: ${CLAIM_WORK_STATUSES.join(", ")}.`,
  });
  return undefined;
}

function readHumanStatus(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (isHumanStatus(value)) return value;
  issues.push({
    code: value === undefined ? "MISSING_FIELD" : "INVALID_STATUS",
    field,
    value,
    message: `${field} must be one of: ${HUMAN_STATUSES.join(", ")}.`,
  });
  return undefined;
}

function readImportance(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (isClaimImportance(value)) return value;
  issues.push({
    code: value === undefined ? "MISSING_FIELD" : "INVALID_STATUS",
    field,
    value,
    message: `${field} must be one of: ${CLAIM_IMPORTANCES.join(", ")}.`,
  });
  return undefined;
}

function readPublicId(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  const id = readRequiredText(value, field, MAX_ID_CHARS, issues);
  if (id === undefined) return undefined;
  if (/^[a-zA-Z0-9._:-]+$/.test(id)) return id;
  issues.push({
    code: "INVALID_ID",
    field,
    value,
    message: `${field} must use only letters, numbers, dot, underscore, colon, or hyphen.`,
  });
  return undefined;
}

function readOptionalPublicId(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (value === undefined) return undefined;
  return readPublicId(value, field, issues);
}

function readRepositoryPath(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  const path = readRequiredText(value, field, MAX_FILE_PATH_CHARS, issues);
  if (path === undefined) return undefined;
  if (isSafeRepositoryPath(path)) return path;
  issues.push({
    code: "INVALID_FIELD",
    field,
    value,
    message: `${field} must be a safe relative repository path.`,
  });
  return undefined;
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  issues: ReflectorIssue[],
) {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({
      code: value === undefined ? "MISSING_FIELD" : "INVALID_FIELD",
      field,
      value,
      message: `${field} must be a non-empty string.`,
    });
    return undefined;
  }
  if (value.length > maxLength) {
    issues.push({
      code: "INVALID_FIELD",
      field,
      value,
      message: `${field} must be ${maxLength} characters or fewer.`,
    });
    return undefined;
  }
  return value.trim();
}

function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  issues: ReflectorIssue[],
) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    issues.push({
      code: "INVALID_FIELD",
      field,
      value,
      message: `${field} must be a string when provided.`,
    });
    return undefined;
  }
  if (value.length > maxLength) {
    issues.push({
      code: "INVALID_FIELD",
      field,
      value,
      message: `${field} must be ${maxLength} characters or fewer.`,
    });
    return undefined;
  }
  return value.trim();
}

function readRequiredCopy(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (value === null) return null;
  return readRequiredText(value, field, MAX_BEHAVIOR_COPY_CHARS, issues);
}

function readNonNegativeInteger(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  issues.push({
    code: value === undefined ? "MISSING_FIELD" : "INVALID_FIELD",
    field,
    value,
    message: `${field} must be a non-negative integer.`,
  });
  return undefined;
}

function readEvidenceLine(
  value: unknown,
  field: string,
  issues: ReflectorIssue[],
) {
  if (isValidEvidenceLine(value)) return value;
  issues.push({
    code: value === undefined ? "MISSING_FIELD" : "INVALID_EVIDENCE",
    field,
    value,
    message: `${field} must be a 1-based post-change line number.`,
  });
  return undefined;
}

function readNow(options: ReflectorApplyOptions) {
  if (typeof options.now === "function") return options.now();
  if (typeof options.now === "string") return options.now;
  return new Date().toISOString();
}

function nextGeneratedId(
  kind: ReflectorGeneratedIdKind,
  state: ReviewState,
  options: ReflectorApplyOptions,
  reserved: Set<string>,
) {
  const generated = options.idFactory?.(kind, state);
  if (
    generated &&
    generated.length <= MAX_ID_CHARS &&
    /^[a-zA-Z0-9._:-]+$/.test(generated) &&
    !reserved.has(generated)
  ) {
    return generated;
  }

  const prefix =
    kind === "evidence"
      ? "evid"
      : kind === "claimRevision"
        ? "claimrev"
        : kind;
  for (let index = reserved.size + 1; ; index += 1) {
    const id = `${prefix}_${String(index).padStart(4, "0")}`;
    if (!reserved.has(id)) {
      return id;
    }
  }
}

function nextClaimOrder(state: ReviewState) {
  return Math.max(0, ...state.claims.map((claim) => claim.order)) + 1;
}

function claimIds(state: ReviewState) {
  return new Set(state.claims.map((claim) => claim.id));
}

function evidenceIds(state: ReviewState) {
  return new Set(
    state.claims.flatMap((claim) =>
      claim.evidences.map((evidence) => evidence.id),
    ),
  );
}

function eventIds(state: ReviewState) {
  return new Set(state.events.map((event) => event.id));
}

function claimRevisionIds(state: ReviewState) {
  return new Set(state.claimHistory.map((revision) => revision.id));
}

function claimStatusSignature(claim: ReviewClaimState) {
  return [claim.lifecycleStatus, claim.workStatus, claim.humanStatus].join("|");
}

function claimsEqual(left: ReviewClaimState, right: ReviewClaimState) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSafeRepositoryPath(path: string) {
  return (
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[a-zA-Z]:[\\/]/.test(path) &&
    !path.split(/[\\/]+/).some((part) => part === "..")
  );
}

function isValidEvidenceLine(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_EVIDENCE_LINE
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
