export type ClaimStatus =
  | "new"
  | "unchanged"
  | "evidence_moved"
  | "amended"
  | "invalidated"
  | "superseded";

export type HumanStatus = "unreviewed" | "accepted";
export type ClaimImportance = "critical" | "important" | "minor" | "noise";

export type AgentEvidence = {
  claimId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  fingerprint?: string;
  revisionId?: string;
  change: string;
};

export type AgentClaim = {
  id: string;
  threadId?: string;
  title?: string;
  agentStatus: ClaimStatus;
  importance?: ClaimImportance;
  humanStatus?: HumanStatus;
  evidences?: AgentEvidence[];
  before?: string | null;
  after?: string | null;
  description?: string;
  updatedAt?: number;
};

export type AgentThread = {
  id: string;
  title: string;
  summary?: string;
  claims: AgentClaim[];
};

export type DraftFileDisposition = "pending" | "acknowledged";

export type DraftFileEntry = {
  path: string;
  additions: number;
  deletions: number;
  disposition: DraftFileDisposition;
  reason?: string;
};

export type AgentApplyPayload = {
  packetId: string;
  sessionId: string;
  revisionId: string;
  gitFingerprint: string;
  files: DraftFileEntry[];
  threads: AgentThread[];
};

export type ValidationPacket = {
  changedFiles: Array<{ path: string; summarized?: boolean }>;
  touchedRanges?: Array<{
    filePath: string;
    ranges: Array<{ startLine: number; endLine: number }>;
  }>;
};

export type ApplyIssue = {
  code:
    | "invalid_field"
    | "missing_field"
    | "file_not_covered"
    | "acknowledged_without_reason"
    | "unknown_file"
    | "missing_prior_claim"
    | "missing_files_section"
    | "stale_fingerprint"
    | "unknown_revision"
    | "payload_too_large"
    | "evidence_out_of_range"
    | "dirty_worktree";
  fix: string;
  field?: string;
  path?: string;
  claimId?: string;
  threadId?: string;
  value?: unknown;
};

const MAX_THREADS_PER_APPLY = 100;
const MAX_CLAIMS_PER_THREAD = 200;
const MAX_EVIDENCES_PER_CLAIM = 50;
const MAX_ID_CHARS = 160;
const MAX_TITLE_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_BEHAVIOR_COPY_CHARS = 4_000;
const MAX_EVIDENCE_CHANGE_CHARS = 1_000;
const MAX_FILE_PATH_CHARS = 1_000;
const MAX_EVIDENCE_LINE = 1_000_000;
const MAX_EVIDENCE_SPAN_LINES = 5_000;

const VALID_AGENT_STATUSES = new Set<ClaimStatus>([
  "new",
  "unchanged",
  "evidence_moved",
  "amended",
  "invalidated",
  "superseded",
]);
const VALID_HUMAN_STATUSES = new Set<HumanStatus>(["unreviewed", "accepted"]);
const VALID_CLAIM_IMPORTANCES = new Set<ClaimImportance>([
  "critical",
  "important",
  "minor",
  "noise",
]);
const VALID_FILE_DISPOSITIONS = new Set<DraftFileDisposition>([
  "pending",
  "acknowledged",
]);

export function validateApplyPayload(
  value: unknown,
  opts: { knownClaimIds: Set<string> },
): {
  payload?: AgentApplyPayload;
  issues: ApplyIssue[];
  submittedClaimIds: Set<string>;
} {
  const issues: ApplyIssue[] = [];
  const submittedClaimIds = new Set<string>();
  if (!isRecord(value)) {
    issues.push({
      code: "invalid_field",
      field: "$",
      value,
      fix: "The review draft must be a JSON object.",
    });
    return { issues, submittedClaimIds };
  }

  const packetId = readRequiredString(value, "packetId", issues);
  const sessionId = readRequiredString(value, "sessionId", issues);
  const revisionId = readRequiredString(value, "revisionId", issues);
  const gitFingerprint = readRequiredString(value, "gitFingerprint", issues);
  const files = readFiles(value.files, issues);
  const threads = readThreads(
    value.threads,
    issues,
    opts.knownClaimIds,
    submittedClaimIds,
  );

  if (
    packetId === undefined ||
    sessionId === undefined ||
    revisionId === undefined ||
    gitFingerprint === undefined ||
    files === undefined ||
    threads === undefined
  ) {
    return { issues, submittedClaimIds };
  }

  return {
    payload: {
      packetId,
      sessionId,
      revisionId,
      gitFingerprint,
      files,
      threads,
    },
    issues,
    submittedClaimIds,
  };
}

export function checkCoverage(
  packet: ValidationPacket,
  payload: AgentApplyPayload,
  preservedEvidencePaths: Iterable<string>,
): ApplyIssue[] {
  const issues: ApplyIssue[] = [];
  const changedPaths = new Set(packet.changedFiles.map((file) => file.path));
  const covered = new Set<string>();

  for (const file of payload.files) {
    if (!changedPaths.has(file.path)) {
      issues.push({
        code: "unknown_file",
        path: file.path,
        fix: `Remove "${file.path}" from the files section; it is not in the pending review packet.`,
      });
      continue;
    }
    if (file.disposition !== "acknowledged") continue;
    if (hasText(file.reason)) {
      covered.add(file.path);
      continue;
    }
    issues.push({
      code: "acknowledged_without_reason",
      path: file.path,
      fix: `Add a reason for acknowledging "${file.path}", or cover it with claim evidence.`,
    });
  }

  for (const path of preservedEvidencePaths) {
    if (changedPaths.has(path)) covered.add(path);
  }
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      for (const evidence of claim.evidences ?? []) {
        if (changedPaths.has(evidence.filePath)) covered.add(evidence.filePath);
      }
    }
  }

  for (const path of changedPaths) {
    if (covered.has(path)) continue;
    issues.push({
      code: "file_not_covered",
      path,
      fix: `Add an evidence span with filePath "${path}" to a claim, or set this file's disposition to "acknowledged" with a reason in the "files" section.`,
    });
  }
  return issues;
}

const EVIDENCE_SPAN_TOLERANCE = 3;

export function checkEvidenceSpans(
  packet: ValidationPacket,
  payload: AgentApplyPayload,
): ApplyIssue[] {
  // Older pending revisions have no touchedRanges; skip the check for them.
  if (!packet.touchedRanges) return [];
  const rangesByFile = new Map<
    string,
    Array<{ startLine: number; endLine: number }>
  >();
  for (const entry of packet.touchedRanges) {
    rangesByFile.set(entry.filePath, entry.ranges);
  }
  const summarized = new Set(
    packet.changedFiles
      .filter((file) => file.summarized)
      .map((file) => file.path),
  );

  const issues: ApplyIssue[] = [];
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      // Only new claims must anchor to changed lines; amended/evidence_moved
      // legitimately re-anchor code that moved elsewhere.
      if (claim.agentStatus !== "new") continue;
      for (const evidence of claim.evidences ?? []) {
        if (summarized.has(evidence.filePath)) continue;
        const ranges = rangesByFile.get(evidence.filePath);
        if (!ranges) continue;
        const intersects = ranges.some(
          (range) =>
            evidence.startLine <= range.endLine + EVIDENCE_SPAN_TOLERANCE &&
            evidence.endLine >= range.startLine - EVIDENCE_SPAN_TOLERANCE,
        );
        if (intersects) continue;
        const rangeList = ranges
          .map((range) => `${range.startLine}-${range.endLine}`)
          .join(", ");
        issues.push({
          code: "evidence_out_of_range",
          path: evidence.filePath,
          claimId: claim.id,
          threadId: thread.id,
          fix: `Evidence span ${evidence.startLine}-${evidence.endLine} in "${evidence.filePath}" does not touch any changed lines. Changed line ranges in this file: ${rangeList}. Copy line numbers from the N| prefixes in the annotated diff, or verify with: nl -ba -- ${shellQuote(evidence.filePath)}.`,
        });
      }
    }
  }
  return issues;
}

export function checkPriorClaims(
  activeClaims: Array<{ id: string; threadId: string }>,
  payload: AgentApplyPayload,
  submittedClaimIds = new Set(
    payload.threads.flatMap((thread) => thread.claims.map((claim) => claim.id)),
  ),
): ApplyIssue[] {
  return activeClaims
    .filter((claim) => !submittedClaimIds.has(claim.id))
    .map((claim) => ({
      code: "missing_prior_claim",
      claimId: claim.id,
      threadId: claim.threadId,
      fix: `Re-add claim "${claim.id}" with at least { "id": "${claim.id}", "agentStatus": "unchanged" } under its thread, or mark it "invalidated"/"superseded". Never delete prior claims.`,
    }));
}

export function formatRejection(draftPath: string, issues: ApplyIssue[]) {
  return [
    "PAIRE_APPLY_REJECTED",
    "Fix every issue listed in the JSON below by editing the draft file, then re-run:",
    `paire review --apply ${draftPath}`,
    "",
    JSON.stringify(
      {
        error: "apply_rejected",
        draftPath,
        issueCount: issues.length,
        issues,
      },
      null,
      2,
    ),
  ].join("\n");
}

function readFiles(value: unknown, issues: ApplyIssue[]) {
  if (!Array.isArray(value)) {
    issues.push({
      code: "missing_files_section",
      field: "files",
      fix: "Use the generated review-draft.json. It contains the required files section for coverage.",
    });
    return undefined;
  }

  const files: DraftFileEntry[] = [];
  value.forEach((file, index) => {
    const field = `files[${index}]`;
    if (!isRecord(file)) {
      issues.push({
        code: "invalid_field",
        field,
        value: file,
        fix: "Each files entry must be an object from the generated draft.",
      });
      return;
    }
    const path = readEvidencePath(file.path, `${field}.path`, issues);
    const additions = readRequiredInteger(file.additions, `${field}.additions`, issues);
    const deletions = readRequiredInteger(file.deletions, `${field}.deletions`, issues);
    const disposition = readDisposition(file.disposition, `${field}.disposition`, issues);
    const reason = readOptionalString(file.reason, `${field}.reason`, issues);
    if (
      path === undefined ||
      additions === undefined ||
      deletions === undefined ||
      disposition === undefined ||
      reason === undefined
    ) {
      return;
    }
    files.push({ path, additions, deletions, disposition, ...(reason ? { reason } : {}) });
  });
  return files;
}

function readThreads(
  value: unknown,
  issues: ApplyIssue[],
  knownClaimIds: Set<string>,
  submittedClaimIds: Set<string>,
) {
  if (!Array.isArray(value)) {
    issues.push({
      code: "missing_field",
      field: "threads",
      fix: "Keep the draft's threads array and add or update claims inside it.",
    });
    return undefined;
  }
  if (value.length > MAX_THREADS_PER_APPLY) {
    issues.push({
      code: "invalid_field",
      field: "threads",
      value: value.length,
      fix: `Use at most ${MAX_THREADS_PER_APPLY} threads.`,
    });
  }

  const threads: AgentThread[] = [];
  value.forEach((thread, threadIndex) => {
    const field = `threads[${threadIndex}]`;
    if (!isRecord(thread)) {
      issues.push({
        code: "invalid_field",
        field,
        value: thread,
        fix: "Each thread must be an object with id, title, and claims.",
      });
      return;
    }
    const id = readPublicId(thread.id, `${field}.id`, issues);
    const title = readTextField(thread.title, `${field}.title`, MAX_TITLE_CHARS, issues);
    const summary = readOptionalTextField(
      thread.summary,
      `${field}.summary`,
      MAX_SUMMARY_CHARS,
      issues,
    );
    if (!Array.isArray(thread.claims)) {
      issues.push({
        code: "missing_field",
        field: `${field}.claims`,
        fix: "Each thread needs a claims array.",
      });
      return;
    }
    if (thread.claims.length > MAX_CLAIMS_PER_THREAD) {
      issues.push({
        code: "invalid_field",
        field: `${field}.claims`,
        value: thread.claims.length,
        fix: `Use at most ${MAX_CLAIMS_PER_THREAD} claims in a thread.`,
      });
    }
    if (id === undefined || title === undefined || summary === undefined) return;
    threads.push({
      id,
      title,
      ...(summary ? { summary } : {}),
      claims: readClaims(
        thread.claims,
        field,
        id,
        issues,
        knownClaimIds,
        submittedClaimIds,
      ),
    });
  });
  return threads;
}

function readClaims(
  value: unknown[],
  threadField: string,
  parentThreadId: string,
  issues: ApplyIssue[],
  knownClaimIds: Set<string>,
  submittedClaimIds: Set<string>,
) {
  const claims: AgentClaim[] = [];
  value.forEach((claim, claimIndex) => {
    const field = `${threadField}.claims[${claimIndex}]`;
    if (!isRecord(claim)) {
      issues.push({
        code: "invalid_field",
        field,
        value: claim,
        fix: "Each claim must be an object.",
      });
      return;
    }
    const id = readPublicId(claim.id, `${field}.id`, issues);
    const rawStatus = claim.agentStatus;
    const agentStatus = readAgentStatus(rawStatus, `${field}.agentStatus`, issues);
    if (id !== undefined) submittedClaimIds.add(id);
    if (id === undefined || agentStatus === undefined) return;

    const isKnownExisting = knownClaimIds.has(id);
    const canHydrateCopy =
      isKnownExisting &&
      (agentStatus === "unchanged" ||
        agentStatus === "evidence_moved" ||
        agentStatus === "invalidated" ||
        agentStatus === "superseded");
    const threadId =
      claim.threadId === undefined
        ? parentThreadId
        : readPublicId(claim.threadId, `${field}.threadId`, issues);
    if (threadId === undefined) return;

    if ("text" in claim && claim.text !== undefined && claim.text !== null) {
      issues.push({
        code: "invalid_field",
        field: `${field}.text`,
        value: claim.text,
        fix: "Claim text is no longer supported; use title, description, before, and after.",
      });
    }

    const copy =
      canHydrateCopy && !requiresReplacementCopy(claim, agentStatus)
        ? readHydratableClaimCopy(claim, field, issues)
        : readRequiredClaimCopy(claim, field, issues);
    const humanStatus = readHumanStatus(claim.humanStatus, `${field}.humanStatus`, issues);
    const evidences = readEvidences(
      claim.evidences,
      field,
      agentStatus,
      isKnownExisting,
      issues,
    );
    if (copy === undefined || humanStatus === undefined || evidences === undefined) return;
    claims.push({
      id,
      threadId,
      agentStatus,
      ...(copy.title ? { title: copy.title } : {}),
      ...(copy.description ? { description: copy.description } : {}),
      ...(copy.importance ? { importance: copy.importance } : {}),
      ...(humanStatus ? { humanStatus } : {}),
      ...(copy.before !== undefined ? { before: copy.before } : {}),
      ...(copy.after !== undefined ? { after: copy.after } : {}),
      ...(evidences ? { evidences } : {}),
    });
  });
  return claims;
}

function readHydratableClaimCopy(
  claim: Record<string, unknown>,
  field: string,
  issues: ApplyIssue[],
) {
  const hasTitle = "title" in claim;
  const hasBefore = "before" in claim;
  const hasAfter = "after" in claim;
  const title = hasTitle
    ? readTextField(claim.title, `${field}.title`, MAX_TITLE_CHARS, issues)
    : "";
  const description = readOptionalTextField(
    claim.description,
    `${field}.description`,
    MAX_DESCRIPTION_CHARS,
    issues,
  );
  const hasImportance = "importance" in claim;
  const importance = hasImportance
    ? readOptionalImportance(claim.importance, `${field}.importance`, issues)
    : undefinedValue();
  const before = hasBefore
    ? readOptionalNullableCopy(claim.before, `${field}.before`, issues)
    : undefinedValue();
  const after = hasAfter
    ? readOptionalNullableCopy(claim.after, `${field}.after`, issues)
    : undefinedValue();
  if (
    title === undefined ||
    description === undefined ||
    (hasImportance && importance === undefined) ||
    (hasBefore && before === undefined) ||
    (hasAfter && after === undefined)
  ) {
    return undefined;
  }
  return { title, description, importance, before, after };
}

function requiresReplacementCopy(
  claim: Record<string, unknown>,
  agentStatus: ClaimStatus,
) {
  return (
    "title" in claim &&
    (agentStatus === "evidence_moved" ||
      agentStatus === "invalidated" ||
      agentStatus === "superseded")
  );
}

function readRequiredClaimCopy(
  claim: Record<string, unknown>,
  field: string,
  issues: ApplyIssue[],
) {
  const title = readTextField(claim.title, `${field}.title`, MAX_TITLE_CHARS, issues);
  const description = readOptionalTextField(
    claim.description,
    `${field}.description`,
    MAX_DESCRIPTION_CHARS,
    issues,
  );
  const importance = readImportance(claim.importance, `${field}.importance`, issues);
  const before = readNullableCopy(claim.before, `${field}.before`, issues);
  const after = readNullableCopy(claim.after, `${field}.after`, issues);
  if (
    title === undefined ||
    description === undefined ||
    importance === undefined ||
    before === undefined ||
    after === undefined
  ) {
    return undefined;
  }
  return { title, description, importance, before, after };
}

function readEvidences(
  value: unknown,
  claimField: string,
  agentStatus: ClaimStatus,
  isKnownExisting: boolean,
  issues: ApplyIssue[],
) {
  if (
    value === undefined &&
    isKnownExisting &&
    canOmitEvidenceRows(agentStatus)
  ) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push({
      code: "missing_field",
      field: `${claimField}.evidences`,
      fix: "New, amended, and evidence_moved claims need evidences[]. Unchanged, invalidated, and superseded prior claims may omit evidences to preserve the stored rows.",
    });
    return undefined;
  }
  if (
    value.length === 0 &&
    isKnownExisting &&
    canOmitEvidenceRows(agentStatus)
  ) {
    return [];
  }
  if (value.length > MAX_EVIDENCES_PER_CLAIM) {
    issues.push({
      code: "invalid_field",
      field: `${claimField}.evidences`,
      value: value.length,
      fix: `Use at most ${MAX_EVIDENCES_PER_CLAIM} evidence spans per claim.`,
    });
  }
  const evidences: AgentEvidence[] = [];
  value.forEach((evidence, evidenceIndex) => {
    const field = `${claimField}.evidences[${evidenceIndex}]`;
    if (!isRecord(evidence)) {
      issues.push({
        code: "invalid_field",
        field,
        value: evidence,
        fix: "Each evidence span must be an object.",
      });
      return;
    }
    if ("before" in evidence || "after" in evidence) {
      issues.push({
        code: "invalid_field",
        field,
        value: evidence,
        fix: "Evidence before/after are no longer supported; set claim before/after and evidence change.",
      });
    }
    const filePath = readEvidencePath(evidence.filePath, `${field}.filePath`, issues);
    const startLine = readEvidenceLine(evidence.startLine, `${field}.startLine`, issues);
    const endLine = readEvidenceLine(evidence.endLine, `${field}.endLine`, issues);
    const symbol = readOptionalString(evidence.symbol, `${field}.symbol`, issues);
    const fingerprint = readOptionalString(
      evidence.fingerprint,
      `${field}.fingerprint`,
      issues,
    );
    const change = readTextField(
      evidence.change,
      `${field}.change`,
      MAX_EVIDENCE_CHANGE_CHARS,
      issues,
    );
    if (
      filePath === undefined ||
      startLine === undefined ||
      endLine === undefined ||
      symbol === undefined ||
      fingerprint === undefined ||
      change === undefined
    ) {
      return;
    }
    if (endLine < startLine || endLine - startLine + 1 > MAX_EVIDENCE_SPAN_LINES) {
      issues.push({
        code: "invalid_field",
        field: `${field}.endLine`,
        value: endLine,
        fix: `Evidence ranges must be ordered and span at most ${MAX_EVIDENCE_SPAN_LINES} lines.`,
      });
      return;
    }
    evidences.push({
      filePath,
      startLine,
      endLine,
      ...(symbol ? { symbol } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      change: change.trim(),
    });
  });
  return evidences;
}

function canOmitEvidenceRows(agentStatus: ClaimStatus) {
  return (
    agentStatus === "unchanged" ||
    agentStatus === "invalidated" ||
    agentStatus === "superseded"
  );
}

function readRequiredString(
  object: Record<string, unknown>,
  field: string,
  issues: ApplyIssue[],
) {
  return readTextField(object[field], field, MAX_ID_CHARS, issues);
}

function readPublicId(value: unknown, field: string, issues: ApplyIssue[]) {
  const id = readTextField(value, field, MAX_ID_CHARS, issues);
  if (id === undefined) return undefined;
  if (/^[a-zA-Z0-9._:-]+$/.test(id)) return id;
  issues.push({
    code: "invalid_field",
    field,
    value,
    fix: "Use only letters, numbers, dot, underscore, colon, or hyphen in ids.",
  });
  return undefined;
}

function readTextField(
  value: unknown,
  field: string,
  maxLength: number,
  issues: ApplyIssue[],
) {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({
      code: value === undefined ? "missing_field" : "invalid_field",
      field,
      value,
      fix: `${field} must be a non-empty string.`,
    });
    return undefined;
  }
  if (value.length > maxLength) {
    issues.push({
      code: "invalid_field",
      field,
      value,
      fix: `${field} must be ${maxLength} characters or fewer.`,
    });
    return undefined;
  }
  return value.trim();
}

function readOptionalTextField(
  value: unknown,
  field: string,
  maxLength: number,
  issues: ApplyIssue[],
) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    issues.push({
      code: "invalid_field",
      field,
      value,
      fix: `${field} must be a string when provided.`,
    });
    return undefined;
  }
  if (value.length > maxLength) {
    issues.push({
      code: "invalid_field",
      field,
      value,
      fix: `${field} must be ${maxLength} characters or fewer.`,
    });
    return undefined;
  }
  return value.trim();
}

function readOptionalString(value: unknown, field: string, issues: ApplyIssue[]) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    issues.push({
      code: "invalid_field",
      field,
      value,
      fix: `${field} must be a string when provided.`,
    });
    return undefined;
  }
  return value.trim();
}

function readRequiredInteger(value: unknown, field: string, issues: ApplyIssue[]) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  issues.push({
    code: value === undefined ? "missing_field" : "invalid_field",
    field,
    value,
    fix: `${field} must be a non-negative integer.`,
  });
  return undefined;
}

function readEvidenceLine(value: unknown, field: string, issues: ApplyIssue[]) {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_EVIDENCE_LINE
  ) {
    return value;
  }
  issues.push({
    code: value === undefined ? "missing_field" : "invalid_field",
    field,
    value,
    fix: `${field} must be a 1-based post-change line number.`,
  });
  return undefined;
}

function readDisposition(value: unknown, field: string, issues: ApplyIssue[]) {
  if (typeof value === "string" && VALID_FILE_DISPOSITIONS.has(value as DraftFileDisposition)) {
    return value as DraftFileDisposition;
  }
  issues.push({
    code: value === undefined ? "missing_field" : "invalid_field",
    field,
    value,
    fix: `${field} must be "pending" or "acknowledged".`,
  });
  return undefined;
}

function readAgentStatus(value: unknown, field: string, issues: ApplyIssue[]) {
  if (typeof value === "string" && VALID_AGENT_STATUSES.has(value as ClaimStatus)) {
    return value as ClaimStatus;
  }
  issues.push({
    code: value === undefined ? "missing_field" : "invalid_field",
    field,
    value,
    fix: `${field} must be one of: new, unchanged, evidence_moved, amended, invalidated, superseded.`,
  });
  return undefined;
}

function readHumanStatus(value: unknown, field: string, issues: ApplyIssue[]) {
  if (value === undefined) return "";
  if (typeof value === "string" && VALID_HUMAN_STATUSES.has(value as HumanStatus)) {
    return value as HumanStatus;
  }
  issues.push({
    code: "invalid_field",
    field,
    value,
    fix: `${field} must be "unreviewed" or "accepted" when provided.`,
  });
  return undefined;
}

function readImportance(value: unknown, field: string, issues: ApplyIssue[]) {
  const importance = readOptionalImportance(value, field, issues);
  if (importance) return importance;
  if (value === undefined) {
    issues.push({
      code: "missing_field",
      field,
      fix: `${field} must be one of: critical, important, minor, noise.`,
    });
  }
  return undefined;
}

function readOptionalImportance(value: unknown, field: string, issues: ApplyIssue[]) {
  if (value === undefined) return undefinedValue();
  if (typeof value === "string" && VALID_CLAIM_IMPORTANCES.has(value as ClaimImportance)) {
    return value as ClaimImportance;
  }
  issues.push({
    code: "invalid_field",
    field,
    value,
    fix: `${field} must be one of: critical, important, minor, noise.`,
  });
  return undefined;
}

function readNullableCopy(value: unknown, field: string, issues: ApplyIssue[]) {
  if (value === null) return null;
  return readTextField(value, field, MAX_BEHAVIOR_COPY_CHARS, issues);
}

function readOptionalNullableCopy(
  value: unknown,
  field: string,
  issues: ApplyIssue[],
) {
  if (value === undefined) return undefinedValue();
  if (value === null) return null;
  return readTextField(value, field, MAX_BEHAVIOR_COPY_CHARS, issues);
}

function readEvidencePath(value: unknown, field: string, issues: ApplyIssue[]) {
  const path = readTextField(value, field, MAX_FILE_PATH_CHARS, issues);
  if (path === undefined) return undefined;
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.split(/[\\/]+/).some((part) => part === "..")
  ) {
    issues.push({
      code: "invalid_field",
      field,
      value,
      fix: `${field} must be a safe relative repository path.`,
    });
    return undefined;
  }
  return path;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function undefinedValue(): undefined {
  return undefined;
}
