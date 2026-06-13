import type {
  AgentClaim,
  AgentEvidence,
  AgentThread,
  DraftFileEntry,
} from "./apply-validation";

export type DraftPacket = {
  packetId: string;
  sessionId: string;
  revisionId: string;
  revisionNumber: number;
  goal: string | null;
  baseCommit: string;
  previousAppliedFingerprint: string | null;
  currentFingerprint: string;
  changedFiles: Array<{
    path: string;
    additions: number;
    deletions: number;
    summarized: boolean;
  }>;
  touchedSnippets: Array<unknown>;
  annotatedDiffPath: string;
  safeInspectionCommands: string[];
};

export type ReviewDraft = {
  formatVersion: 2;
  packetId: string;
  sessionId: string;
  revisionId: string;
  gitFingerprint: string;
  _readonlyHeader: string;
  instructions: string[];
  files: DraftFileEntry[];
  threads: DraftThread[];
  context: {
    _readonly: string;
    goal: string | null;
    revisionNumber: number;
    diffCommand: string;
    annotatedDiffPath: string;
    touchedSnippets: Array<unknown>;
    safeInspectionCommands: string[];
    claimTemplate: {
      id: string;
      threadId: string;
      title: string;
      agentStatus: "new";
      importance: string;
      evidences: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        change: string;
      }>;
      before: string;
      after: string;
      description: string;
    };
  };
};

type DraftThread = Omit<AgentThread, "claims"> & {
  claims: DraftClaim[];
};

type DraftClaim = {
  id: string;
  agentStatus: "unchanged";
  _current: {
    title: string;
    importance: string;
    before: string | null;
    after: string | null;
    description?: string;
    evidences: AgentEvidence[];
  };
  _hint: string;
};

export const REVIEW_DRAFT_INSTRUCTIONS = [
  "Edit this file in place, then run: paire review --apply <this file's path>.",
  "Group claims into threads by review area; put the area a reviewer must understand first as the first thread.",
  "importance: critical = correctness/security/data-loss; important = meaningful behavior change; minor = polish/tests/config; noise = mechanical churn (group noise in its own thread).",
  "Leave prior claims that are still accurate exactly as listed (agentStatus \"unchanged\"); never delete a prior claim — mark it invalidated or superseded instead.",
  "Every file under \"files\" must end up referenced by at least one evidence filePath, or have disposition \"acknowledged\" with a reason. Only acknowledge mechanical/generated churn.",
  "Evidence startLine/endLine are 1-based line numbers in the post-change file. Read context.annotatedDiffPath and copy them from the N| prefixes; -N| marks a removed line by its old number, so never copy a -N. Double-check with nl -ba on the file (in context.safeInspectionCommands). Prefer several narrow spans (context.touchedSnippets.addedRanges shows the contiguous groups).",
  "claim.before/after: one-sentence behavior summaries (null for pure additions/removals); never mention file paths or line numbers. evidence.change: required verb-first imperative one-liner.",
  "Titles short and verb-first; description only adds detail beyond the title; Markdown allowed.",
];

export function buildReviewDraft(packet: DraftPacket, activeClaims: AgentClaim[]) {
  return {
    formatVersion: 2,
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    revisionId: packet.revisionId,
    gitFingerprint: packet.currentFingerprint,
    _readonlyHeader:
      "Do not edit packetId, sessionId, revisionId, gitFingerprint, or formatVersion. Apply will fail if they change.",
    instructions: REVIEW_DRAFT_INSTRUCTIONS,
    files: packet.changedFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      disposition: file.summarized ? "acknowledged" : "pending",
      ...(file.summarized
        ? { reason: "Auto-acknowledged: lockfile/generated churn" }
        : {}),
    })),
    threads: draftThreads(activeClaims),
    context: {
      _readonly:
        "Informational only. Apply ignores context, instructions, and every _-prefixed key.",
      goal: packet.goal,
      revisionNumber: packet.revisionNumber,
      diffCommand: `git diff ${packet.previousAppliedFingerprint ?? packet.baseCommit}..HEAD`,
      annotatedDiffPath: packet.annotatedDiffPath,
      touchedSnippets: packet.touchedSnippets,
      safeInspectionCommands: packet.safeInspectionCommands,
      claimTemplate: {
        id: "claim_<short_snake_case_slug>",
        threadId: "thread_<slug>",
        title: "<short, verb-first>",
        agentStatus: "new",
        importance: "<critical|important|minor|noise>",
        evidences: [
          {
            filePath: "<changed file>",
            startLine: 0,
            endLine: 0,
            change: "<imperative one-liner>",
          },
        ],
        before: "<behavior before, or null>",
        after: "<behavior after, or null>",
        description: "<optional detail beyond the title>",
      },
    },
  } satisfies ReviewDraft;
}

export function stripDraftAnnotations(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return raw.map((item) => stripDraftAnnotations(item));
  }
  if (!isRecord(raw)) return raw;

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      key === "context" ||
      key === "instructions" ||
      key === "formatVersion" ||
      key.startsWith("_")
    ) {
      continue;
    }
    stripped[key] = stripDraftAnnotations(value);
  }
  return stripped;
}

function draftThreads(activeClaims: AgentClaim[]) {
  const threads = new Map<string, DraftThread>();
  for (const claim of activeClaims) {
    if (!claim.threadId) continue;
    const thread = threads.get(claim.threadId);
    if (thread) {
      thread.claims.push(draftClaim(claim));
      continue;
    }
    threads.set(claim.threadId, {
      id: claim.threadId,
      title: readThreadTitle(claim),
      claims: [draftClaim(claim)],
    });
  }
  return [...threads.values()];
}

function draftClaim(claim: AgentClaim) {
  return {
    id: claim.id,
    agentStatus: "unchanged",
    _current: {
      title: requiredClaimField(claim.title, claim.id, "title"),
      importance: requiredClaimField(claim.importance, claim.id, "importance"),
      before: claim.before ?? null,
      after: claim.after ?? null,
      ...(claim.description ? { description: claim.description } : {}),
      evidences: claim.evidences ?? [],
    },
    _hint:
      "Still accurate? Leave untouched. Code moved? Set \"evidence_moved\" + add evidences. Meaning changed? Set \"amended\" and fill all fields like a new claim. No longer true? \"invalidated\" or \"superseded\".",
  } satisfies DraftClaim;
}

function readThreadTitle(claim: AgentClaim) {
  const titled = claim as AgentClaim & { threadTitle?: string };
  if (typeof titled.threadTitle === "string" && titled.threadTitle.trim()) {
    return titled.threadTitle.trim();
  }
  return claim.threadId ?? "Prior claims";
}

function requiredClaimField(
  value: string | undefined,
  claimId: string,
  field: string,
) {
  if (value && value.trim()) return value.trim();
  throw new Error(`Cannot build review draft: claim ${claimId} is missing ${field}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
