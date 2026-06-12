import { parsePatchFiles } from "@pierre/diffs";
import { Database } from "bun:sqlite";

import { addedLineRanges, annotateHunkText } from "./diff-line-numbers";
import {
  checkCoverage,
  checkPriorClaims,
  formatRejection,
  validateApplyPayload,
  type AgentApplyPayload,
  type AgentClaim,
  type AgentEvidence,
  type AgentThread,
  type ApplyIssue,
  type ClaimImportance,
  type ClaimStatus,
  type HumanStatus,
} from "./apply-validation";
import { buildReviewDraft, stripDraftAnnotations } from "./review-draft";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  formatInstallResult,
  installAgentInstructions,
} from "./install-agent-instructions";
import { PAIRE_VERSION } from "./version";
import reviewApp from "../local-app/index.html";

export type CliOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  openBrowser?: (url: string) => Promise<void> | void;
};

type SessionRow = {
  id: string;
  repoRoot: string;
  projectKey: string;
  goal: string | null;
  baseRef: string;
  baseCommit: string;
  branch: string;
  upstream: string | null;
  createdAt: number;
  updatedAt: number;
};

type RevisionRow = {
  id: string;
  sessionId: string;
  number: number;
  state: "pending_agent" | "applied" | "superseded";
  gitFingerprint: string;
  packetArtifactId: string | null;
  packetJson: string | null;
  packetExportPath: string | null;
  resultPath: string | null;
  totalDiffArtifactId: string | null;
  createdAt: number;
  appliedAt: number | null;
};

export type ClaimRevisionRow = {
  id: string;
  claimId: string;
  sessionId: string;
  revisionId: string;
  agentStatus: ClaimStatus;
  title: string;
  description: string;
  beforeText: string | null;
  afterText: string | null;
  importance: ClaimImportance;
  evidencesJson: string;
  createdAt: number;
};

type GitState = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  head: string;
  clean: boolean;
  fingerprint: string;
  status: string;
};

type Packet = {
  packetId: string;
  sessionId: string;
  projectKey: string;
  revisionId: string;
  revisionNumber: number;
  goal: string | null;
  baseRef: string;
  baseCommit: string;
  previousAppliedRevisionId: string | null;
  previousAppliedFingerprint: string | null;
  currentFingerprint: string;
  currentBranch: string;
  changedFiles: ChangedFile[];
  totalDiffArtifactPath: string;
  incrementalDiffArtifactPath: string;
  touchedSnippets: TouchedSnippet[];
  activeClaims: Array<AgentClaim & { threadTitle: string }>;
  safeInspectionCommands: string[];
  resultSchema: Record<string, unknown>;
  rules: string[];
};

type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
  summarized: boolean;
};

type TouchedSnippet = {
  filePath: string;
  startLine: number;
  endLine: number;
  hunkHeader?: string;
  text: string;
  addedRanges?: Array<{ startLine: number; endLine: number }>;
  summarized: boolean;
};

type StoredAgentClaim = AgentClaim & {
  threadId: string;
  title: string;
  importance: ClaimImportance;
  evidences: AgentEvidence[];
};

const LARGE_DIFF_BYTES = 30_000;
const MAX_INLINE_SNIPPET_CHARS = 4_000;
const MAX_TOTAL_SNIPPET_CHARS = 18_000;
const MAX_APPLY_PAYLOAD_BYTES = 2_000_000;
const MAX_COMMENT_CHARS = 4_000;
const REVIEW_PORT = 22222;
const MAX_REVIEW_PORT_ATTEMPTS = 100;
const REVIEW_SERVER_START_TIMEOUT_MS = 5_000;
const REVIEW_TOKEN_BYTES = 16;
const REVIEW_TOKEN_HEADER = "x-paire-review-token";
// Shut the shared daemon down after this long with no requests. Generous so a
// browser tab left open after the terminal closes keeps working for a while.
const REVIEW_IDLE_TIMEOUT_MS = 30 * 60_000;
const REVIEW_IDLE_CHECK_MS = 60_000;

// Per-session record of "where is this branch's review UI". The pid/port now
// point at the shared daemon; many sessions share them.
type ReviewServerState = {
  pid: number;
  port: number;
  url: string;
  token: string;
  sessionId: string;
  repoRoot: string;
  startedAt: number;
};

// The single shared review daemon. One per ~/.paire, bound to a fixed port.
type ReviewDaemonState = {
  pid: number;
  port: number;
  baseUrl: string;
  adminToken: string;
  version: string;
  startedAt: number;
};

type ReviewRegistryEntry = { sessionId: string; repoRoot: string };

type SessionResolution =
  | { session: SessionRow }
  | { error: string; status: number };
const VALID_HUMAN_STATUSES = new Set(["unreviewed", "accepted"]);
const CLAIM_IMPORTANCE_ORDER: ClaimImportance[] = [
  "critical",
  "important",
  "minor",
  "noise",
];
const CLAIM_IMPORTANCE_RANK: Record<ClaimImportance, number> = {
  critical: 0,
  important: 1,
  minor: 2,
  noise: 3,
};

export async function runCli(argv: string[], options: CliOptions = {}) {
  const ctx = makeContext(options);
  const [command = "help", ...rest] = argv;
  try {
    switch (command) {
      case "start":
        await startCommand(rest, ctx);
        return 0;
      case "review":
        return await reviewCommand(rest, ctx);
      case "it":
        await itCommand(rest, ctx);
        return 0;
      case "reset":
        await resetCommand(ctx);
        return 0;
      case "server":
        await serverCommand(rest, ctx);
        return 0;
      case "status":
        await statusCommand(ctx);
        return 0;
      case "sync":
        await syncCommand(ctx);
        return 0;
      case "install":
        installCommand(ctx);
        return 0;
      case "version":
      case "--version":
      case "-v":
        ctx.stdout(PAIRE_VERSION);
        return 0;
      case "_review-serve": {
        await reviewServeCommand(ctx);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        ctx.stdout(helpText());
        return 0;
      default:
        ctx.stderr(`Unknown command: ${command}\n\n${helpText()}`);
        return 1;
    }
  } catch (error) {
    ctx.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function makeContext(options: CliOptions) {
  const env = { ...process.env, ...options.env };
  const stdout = options.stdout ?? ((message: string) => console.log(message));
  const stderr =
    options.stderr ?? ((message: string) => console.error(message));
  const cwd = resolve(options.cwd ?? process.cwd());
  const paireHome = resolve(env.PAIRE_HOME ?? join(homedir(), ".paire"));
  ensurePrivateDirectory(paireHome);
  ensurePrivateDirectory(join(paireHome, "artifacts"));
  ensurePrivateDirectory(join(paireHome, "projects"));
  ensurePrivateDirectory(join(paireHome, "review-servers"));
  const dbPath = join(paireHome, "paire.db");
  const db = new Database(dbPath);
  ensurePrivateFile(dbPath);
  migrate(db);
  return {
    cwd,
    env,
    paireHome,
    artifactsDir: join(paireHome, "artifacts"),
    projectsDir: join(paireHome, "projects"),
    db,
    stdout,
    stderr,
    openBrowser:
      options.openBrowser ?? ((url: string) => openBrowser(url, env)),
  };
}

type Context = ReturnType<typeof makeContext>;

async function startCommand(args: string[], ctx: Context) {
  const parsed = parseFlags(args);
  const git = getGitState(ctx.cwd);
  const projectKey = detectProjectKey(git.repoRoot);
  const baseRef = stringFlag(parsed, "base") ?? detectBaseRef(git.repoRoot);
  const baseCommit =
    gitCommand(["merge-base", "HEAD", baseRef], git.repoRoot, {
      allowFail: true,
    }).trim() || git.head;
  const goal = stringFlag(parsed, "goal") ?? null;
  const existing = getSession(ctx.db, git.repoRoot, git.branch);
  const now = Date.now();
  const sessionId = existing?.id ?? `ses_${crypto.randomUUID()}`;

  if (existing) {
    ctx.db
      .prepare(
        `update sessions set goal = ?, baseRef = ?, baseCommit = ?, branch = ?, upstream = ?, updatedAt = ? where id = ?`,
      )
      .run(
        goal ?? existing.goal,
        baseRef,
        baseCommit,
        git.branch,
        git.upstream,
        now,
        existing.id,
      );
    if (existing.projectKey !== projectKey) {
      ctx.db
        .prepare("update sessions set projectKey = ? where id = ?")
        .run(projectKey, existing.id);
    }
  } else {
    ctx.db
      .prepare(
        `insert into sessions (id, repoRoot, projectKey, goal, baseRef, baseCommit, branch, upstream, createdAt, updatedAt)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        git.repoRoot,
        projectKey,
        goal,
        baseRef,
        baseCommit,
        git.branch,
        git.upstream,
        now,
        now,
      );
  }

  if (!getLastAppliedRevision(ctx.db, sessionId)) {
    insertAppliedBaselineRevision(ctx.db, sessionId, baseCommit, now);
  }

  ctx.stdout(
    [
      "Paire session ready.",
      `Session ID: ${sessionId}`,
      `Base branch/ref: ${baseRef}`,
      `Base commit: ${baseCommit}`,
      `Current branch: ${git.branch}`,
      `Project key: ${projectKey}`,
      `Current git fingerprint: ${git.fingerprint}`,
      "Next: paire review",
    ].join("\n"),
  );
}

async function reviewCommand(args: string[], ctx: Context): Promise<number> {
  const parsed = parseFlags(args);
  const applyPath = stringFlag(parsed, "apply");
  const checkPath = stringFlag(parsed, "check");
  if (applyPath || parsed.flags.has("stdin")) {
    return await applyReviewCommand(
      applyPath,
      parsed.flags.has("stdin"),
      parsed.flags.has("no-open"),
      ctx,
    );
  }
  if (checkPath) {
    return await checkReviewCommand(checkPath, ctx);
  }

  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  if (!session) {
    const base = detectBaseRef(git.repoRoot);
    ctx.stdout(`No Paire session found.\nRun:\npaire start --base ${base}`);
    return 0;
  }
  if (!git.clean) {
    ctx.stdout(dirtyWorktreeMessage(git));
    await openReviewUi(ctx, session, git);
    return 0;
  }
  const lastApplied = getLastAppliedRevision(ctx.db, session.id);
  if (lastApplied?.gitFingerprint === git.fingerprint) {
    await printStatusAndOpen(session, git, ctx);
    return 0;
  }

  const packet = await createPendingPacket(ctx, session, git, lastApplied);
  const diffFrom = lastApplied?.gitFingerprint ?? session.baseCommit;
  const diffFromLabel = lastApplied
    ? `last applied commit ${diffFrom}`
    : `base commit ${diffFrom}`;
  ctx.stdout(
    reviewActionRequiredMessage({
      diffFrom,
      diffFromLabel,
      lastAppliedId: lastApplied?.id ?? null,
      packet,
    }),
  );
  return 0;
}

function installCommand(ctx: Context) {
  const result = installAgentInstructions(getGitRepoRoot(ctx.cwd));
  ctx.stdout(formatInstallResult(result));
}

async function itCommand(args: string[], ctx: Context) {
  const git = getGitState(ctx.cwd);
  if (!getSession(ctx.db, git.repoRoot, git.branch)) {
    await startCommand(args, ctx);
  }
  await reviewCommand([], ctx);
}

async function applyReviewCommand(
  applyPath: string | undefined,
  useStdin: boolean,
  noOpen: boolean,
  ctx: Context,
) {
  const draftPath = useStdin
    ? "(stdin)"
    : resolveRequiredPath(applyPath, "Missing --apply file.");
  const result = await validateReviewDraft(draftPath, useStdin, ctx);
  if (result.issues.length > 0 || !result.ready) {
    ctx.stderr(formatRejection(draftPath, result.issues));
    return 1;
  }
  const { payload, session, git, revision } = result.ready;

  const apply = ctx.db.transaction((value: AgentApplyPayload) => {
    let applyOrder = Date.now();
    for (const thread of value.threads) {
      const threadDbId = scopedDbId(session.id, thread.id);
      const existingThread = ctx.db
        .query<
          { title: string; summary: string; updatedAt: number },
          [string, string]
        >(
          "select title, summary, updatedAt from change_threads where id = ? and sessionId = ?",
        )
        .get(threadDbId, session.id);
      const preserveExistingThreadCopy =
        !!existingThread &&
        thread.claims.length > 0 &&
        thread.claims.every((claim) => canPreserveExistingThreadCopy(claim));
      ctx.db
        .prepare(
          `insert into change_threads (id, sessionId, title, summary, updatedAt)
           values (?, ?, ?, ?, ?)
           on conflict(id) do update set title = excluded.title, summary = excluded.summary, updatedAt = excluded.updatedAt`,
        )
        .run(
          threadDbId,
          session.id,
          preserveExistingThreadCopy ? existingThread.title : thread.title,
          preserveExistingThreadCopy
            ? existingThread.summary
            : (thread.summary ?? ""),
          preserveExistingThreadCopy && existingThread
            ? existingThread.updatedAt
            : ++applyOrder,
        );
      for (const claim of thread.claims) {
        const claimDbId = scopedDbId(session.id, claim.id);
        const claimThreadId = claim.threadId ?? thread.id;
        const claimThreadDbId = scopedDbId(session.id, claimThreadId);
        const existingClaim = ctx.db
          .query<
            {
              title: string;
              description: string;
              beforeText: string | null;
              afterText: string | null;
              importance: ClaimImportance;
              humanStatus: HumanStatus;
              updatedAt: number;
            },
            [string, string]
          >(
            "select title, description, beforeText, afterText, importance, humanStatus, updatedAt from claims where id = ? and sessionId = ?",
          )
          .get(claimDbId, session.id);
        const preserveClaimCopy =
          !!existingClaim &&
          canPreserveExistingClaimCopy(claim);
        const claimCopy = finalClaimCopy(claim, existingClaim, preserveClaimCopy);
        const claimTitle = claimCopy.title;
        const claimDescription = claimCopy.description;
        const claimBefore = preserveClaimCopy
          ? existingClaim.beforeText
          : normalizeNullableCopy(claim.before);
        const claimAfter = preserveClaimCopy
          ? existingClaim.afterText
          : normalizeNullableCopy(claim.after);
        const claimHumanStatus =
          existingClaim && !preserveClaimCopy
            ? "unreviewed"
            : (existingClaim?.humanStatus ?? claim.humanStatus ?? "unreviewed");
        ctx.db
          .prepare(
            `insert into claims (id, threadId, sessionId, title, description, beforeText, afterText, agentStatus, importance, humanStatus, updatedAt)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set threadId = excluded.threadId, title = excluded.title,
               description = excluded.description,
               beforeText = excluded.beforeText, afterText = excluded.afterText,
               agentStatus = excluded.agentStatus, importance = excluded.importance,
               humanStatus = excluded.humanStatus, updatedAt = excluded.updatedAt`,
          )
          .run(
            claimDbId,
            claimThreadDbId,
            session.id,
            claimTitle,
            claimDescription,
            claimBefore,
            claimAfter,
            claim.agentStatus,
            preserveClaimCopy && existingClaim
              ? existingClaim.importance
              : requiredImportance(claim),
            claimHumanStatus,
            preserveClaimCopy && existingClaim
              ? existingClaim.updatedAt
              : ++applyOrder,
          );
        const preserveEvidenceRows =
          canPreserveExistingEvidenceRows(claim.agentStatus) &&
          (!claim.evidences || claim.evidences.length === 0);
        const submittedEvidences = claim.evidences ?? [];
        if (!preserveEvidenceRows) {
          ctx.db
            .prepare("delete from claim_evidences where claimId = ?")
            .run(claimDbId);
          for (const evidence of submittedEvidences) {
            ctx.db
              .prepare(
                `insert into claim_evidences (id, claimId, revisionId, filePath, startLine, endLine, symbol, fingerprint, changeText)
                 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                `ev_${crypto.randomUUID()}`,
                claimDbId,
                revision.id,
                evidence.filePath,
                evidence.startLine,
                evidence.endLine,
                evidence.symbol ?? null,
                evidence.fingerprint ?? null,
                evidence.change.trim(),
              );
          }
        }
        if (claim.agentStatus !== "unchanged") {
          appendClaimRevision(ctx.db, {
            claimId: claimDbId,
            sessionId: session.id,
            revisionId: revision.id,
            agentStatus: claim.agentStatus,
            title: claimTitle,
            description: claimDescription,
            beforeText: claimBefore,
            afterText: claimAfter,
            importance: preserveClaimCopy && existingClaim
              ? existingClaim.importance
              : requiredImportance(claim),
            evidences: submittedEvidences,
            createdAt: ++applyOrder,
          });
        }
      }
    }
    ctx.db
      .prepare(
        "update revisions set state = 'applied', appliedAt = ? where id = ?",
      )
      .run(Date.now(), revision.id);
    ctx.db
      .prepare(
        "update revisions set state = 'superseded' where sessionId = ? and state = 'pending_agent' and id != ?",
      )
      .run(session.id, revision.id);
  });
  apply(payload);

  ctx.stdout(formatStatus(ctx.db, session, git));
  if (!noOpen) {
    await openReviewUi(ctx, session, git);
  }
  return 0;
}

async function checkReviewCommand(checkPath: string, ctx: Context) {
  const draftPath = resolve(checkPath);
  const result = await validateReviewDraft(draftPath, false, ctx);
  if (result.issues.length > 0 || !result.ready) {
    ctx.stderr(formatRejection(draftPath, result.issues));
    return 1;
  }
  ctx.stdout("PAIRE_DRAFT_OK");
  return 0;
}

type ReadyApplyDraft = {
  payload: AgentApplyPayload;
  session: SessionRow;
  git: GitState;
  revision: RevisionRow;
  packet: Packet;
};

async function validateReviewDraft(
  draftPath: string,
  useStdin: boolean,
  ctx: Context,
): Promise<{ ready?: ReadyApplyDraft; issues: ApplyIssue[] }> {
  const raw = useStdin ? await new Response(Bun.stdin).text() : await Bun.file(draftPath).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      issues: [
        {
          code: "invalid_field",
          field: "$",
          value: error instanceof Error ? error.message : String(error),
          fix: "Fix the draft so it is valid JSON, then re-run the command.",
        },
      ],
    };
  }

  const stripped = stripDraftAnnotations(parsed);
  const strippedBytes = new TextEncoder().encode(JSON.stringify(stripped)).length;
  if (strippedBytes > MAX_APPLY_PAYLOAD_BYTES) {
    return {
      issues: [
        {
          code: "payload_too_large",
          value: strippedBytes,
          fix: `The stripped apply payload is too large; keep it under ${MAX_APPLY_PAYLOAD_BYTES} bytes.`,
        },
      ],
    };
  }

  const sessionId = readStringProperty(stripped, "sessionId");
  const session = sessionId
    ? ctx.db
        .query<SessionRow, [string]>("select * from sessions where id = ?")
        .get(sessionId)
    : null;
  const activeClaims = session ? getActiveClaims(ctx.db, session.id) : [];
  const knownClaimIds = new Set(activeClaims.map((claim) => claim.id));
  const validation = validateApplyPayload(stripped, { knownClaimIds });
  const issues = [...validation.issues];
  const payload = validation.payload;

  if (!payload) return { issues };
  if (!session) {
    issues.push({
      code: "unknown_revision",
      field: "sessionId",
      value: payload.sessionId,
      fix: "Run paire review again and edit the generated review-draft.json for the current session.",
    });
    return { issues };
  }

  const git = getGitState(session.repoRoot);
  if (!git.clean) {
    issues.push({
      code: "dirty_worktree",
      fix: "Commit the current worktree changes, then run paire review again.",
    });
  }
  if (git.fingerprint !== payload.gitFingerprint) {
    issues.push({
      code: "stale_fingerprint",
      field: "gitFingerprint",
      value: payload.gitFingerprint,
      fix: `Run paire review again; the draft fingerprint does not match current HEAD ${git.fingerprint}.`,
    });
  }

  const revision = ctx.db
    .query<RevisionRow, [string]>("select * from revisions where id = ?")
    .get(payload.revisionId);
  if (!revision || revision.state !== "pending_agent") {
    issues.push({
      code: "unknown_revision",
      field: "revisionId",
      value: payload.revisionId,
      fix: "Run paire review again and edit the current pending review-draft.json.",
    });
    return { issues };
  }
  if (revision.gitFingerprint !== payload.gitFingerprint) {
    issues.push({
      code: "stale_fingerprint",
      field: "gitFingerprint",
      value: payload.gitFingerprint,
      fix: "Run paire review again; this draft does not match the pending revision fingerprint.",
    });
  }

  const packet = parseStoredPacket(revision);
  if (!packet || packet.packetId !== payload.packetId) {
    issues.push({
      code: "unknown_revision",
      field: "packetId",
      value: payload.packetId,
      fix: "Run paire review again; this draft does not match the canonical pending packet.",
    });
    return { issues };
  }

  issues.push(
    ...checkPriorClaims(
      activeClaims.flatMap((claim) =>
        claim.threadId ? [{ id: claim.id, threadId: claim.threadId }] : [],
      ),
      payload,
      validation.submittedClaimIds,
    ),
    ...checkCoverage(
      packet,
      payload,
      preservedEvidencePaths(ctx.db, session.id, payload),
    ),
  );

  if (issues.length > 0) return { issues };
  return { ready: { payload, session, git, revision, packet }, issues };
}

function readStringProperty(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found.trim() ? found : null;
}

function preservedEvidencePaths(
  db: Database,
  sessionId: string,
  payload: AgentApplyPayload,
) {
  const paths: string[] = [];
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      if (
        claim.agentStatus !== "unchanged" ||
        (claim.evidences && claim.evidences.length > 0)
      ) {
        continue;
      }
      const claimDbId = scopedDbId(sessionId, claim.id);
      const rows = db
        .query<{ filePath: string }, [string]>(
          "select filePath from claim_evidences where claimId = ?",
        )
        .all(claimDbId);
      for (const row of rows) paths.push(row.filePath);
    }
  }
  return paths;
}

async function statusCommand(ctx: Context) {
  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  ctx.stdout(
    session
      ? formatStatus(ctx.db, session, git)
      : `No Paire session found.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`,
  );
}

async function syncCommand(ctx: Context) {
  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  const status = session
    ? formatStatus(ctx.db, session, git)
    : `No Paire session found.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`;
  ctx.stdout(
    `${status}\n\nCloud sync is not configured in this local build. Run paire review to update or open the local review.`,
  );
}

async function serverCommand(args: string[], ctx: Context) {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "start":
      await serverStartCommand(rest, ctx);
      return;
    case "stop":
      await serverStopCommand(ctx);
      return;
    case "help":
    case "--help":
    case "-h":
      ctx.stdout(serverHelpText());
      return;
    default:
      throw new Error(`Unknown server command: ${subcommand}\n\n${serverHelpText()}`);
  }
}

async function serverStartCommand(args: string[], ctx: Context) {
  const parsed = parseFlags(args);
  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  if (!session) {
    ctx.stdout(
      `No Paire session found for branch ${git.branch}.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`,
    );
    return;
  }

  const state = await ensureReviewServer(ctx, session);
  if (!parsed.flags.has("no-open")) {
    await ctx.openBrowser(state.url);
  }
  ctx.stdout(reviewUiMessage(state.url));
}

async function serverStopCommand(ctx: Context) {
  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  if (!session) {
    ctx.stdout(
      `No Paire session found for branch ${git.branch}.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`,
    );
    return;
  }

  const outcome = await stopReviewSession(ctx, session);
  if (outcome === "stopped") {
    ctx.stdout("Stopped the review UI server.");
    return;
  }
  if (outcome === "stale") {
    ctx.stdout("Review UI server was not running. Removed stale state.");
    return;
  }
  ctx.stdout("No review UI server is running for this branch.");
}

async function resetCommand(ctx: Context) {
  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  if (!session) {
    ctx.stdout(
      `No Paire session found for branch ${git.branch}.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`,
    );
    return;
  }

  const baseCommit =
    gitCommand(["merge-base", "HEAD", session.baseRef], session.repoRoot, {
      allowFail: true,
    }).trim() || git.head;
  const now = Date.now();

  const reset = ctx.db.transaction(
    (sessionId: string, baselineFingerprint: string, updatedAt: number) => {
      ctx.db
        .prepare(
          `delete from human_review_marks
          where claimId in (select id from claims where sessionId = ?)`,
        )
        .run(sessionId);
      ctx.db
        .prepare(
          `delete from claim_evidences
          where claimId in (select id from claims where sessionId = ?)`,
        )
        .run(sessionId);
      ctx.db.prepare("delete from claims where sessionId = ?").run(sessionId);
      ctx.db
        .prepare("delete from change_threads where sessionId = ?")
        .run(sessionId);
      ctx.db.prepare("delete from revisions where sessionId = ?").run(sessionId);
      ctx.db
        .prepare("update sessions set baseCommit = ?, updatedAt = ? where id = ?")
        .run(baselineFingerprint, updatedAt, sessionId);
      insertAppliedBaselineRevision(ctx.db, sessionId, baselineFingerprint, updatedAt);
    },
  );
  reset(session.id, baseCommit, now);
  clearProjectReviewExports(ctx, session);
  ctx.stdout(
    `Reset Paire session for branch ${git.branch}. Review baseline set to ${baseCommit}.`,
  );
}

async function createPendingPacket(
  ctx: Context,
  session: SessionRow,
  git: GitState,
  lastApplied: RevisionRow | null,
) {
  const existing = ctx.db
    .query<
      RevisionRow,
      [string, string]
    >("select * from revisions where sessionId = ? and state = 'pending_agent' and gitFingerprint = ? order by createdAt desc limit 1")
    .get(session.id, git.fingerprint);
  const number = existing?.number ?? nextRevisionNumber(ctx.db, session.id);
  const revisionId = existing?.id ?? `rev_${crypto.randomUUID()}`;
  const totalDiff = gitDiffForCurrentState(
    session.baseCommit,
    session.repoRoot,
  );
  const incrementalDiff = lastApplied
    ? gitDiffForCurrentState(lastApplied.gitFingerprint, session.repoRoot)
    : totalDiff;
  const packetId = `pkt_${revisionId}`;
  const totalDiffArtifactPath = await writeArtifact(
    ctx,
    "total-diff",
    `${packetId}.total.diff`,
    totalDiff,
  );
  const incrementalDiffArtifactPath = await writeArtifact(
    ctx,
    "incremental-diff",
    `${packetId}.incremental.diff`,
    incrementalDiff,
  );
  const totalDiffArtifactId = insertArtifactRef(
    ctx.db,
    "total-diff",
    totalDiffArtifactPath,
  );
  const changedFiles = summarizeChangedFiles(incrementalDiff);
  const safeInspectionCommands = changedFiles
    .filter((file) => file.summarized)
    .flatMap((file) => [
      `git diff --stat -- ${shellQuote(file.path)}`,
      `git diff --unified=40 -- ${shellQuote(file.path)}`,
    ]);
  const packet: Packet = {
    packetId,
    sessionId: session.id,
    projectKey: session.projectKey,
    revisionId,
    revisionNumber: number,
    goal: session.goal,
    baseRef: session.baseRef,
    baseCommit: session.baseCommit,
    previousAppliedRevisionId: lastApplied?.id ?? null,
    previousAppliedFingerprint: lastApplied?.gitFingerprint ?? null,
    currentFingerprint: git.fingerprint,
    currentBranch: git.branch,
    changedFiles,
    totalDiffArtifactPath,
    incrementalDiffArtifactPath,
    touchedSnippets: touchedSnippets(incrementalDiff),
    activeClaims: getActiveClaims(ctx.db, session.id),
    safeInspectionCommands,
    resultSchema: {
      packetId: "string",
      sessionId: "string",
      revisionId: "string",
      gitFingerprint: "string",
      threads:
        "Array<{ id, title, summary?, claims: Array<{ id, threadId, title, agentStatus, importance: v.union(v.literal(\"critical\"), v.literal(\"important\"), v.literal(\"minor\"), v.literal(\"noise\")), humanStatus?, evidences: Array<{ filePath, startLine, endLine, symbol?, fingerprint?, change }>, before?, after?, description? }> }>",
    },
    rules: [
      "Group related claims into area threads. Treat each thread as one review area with a short area title, not as a single diff line or file.",
      "Order areas and claims for review, not alphabetically: start with the main behavior or core contract, then supporting helpers, then consumers/usages, then tests, generated files, config, and lockfiles.",
      "Use the first area for the most important files or behavior a reviewer needs to understand before the rest of the change makes sense.",
      "Set every claim importance to one of: critical, important, minor, noise. Critical means a correctness, security, data-loss, or release-blocking behavior change; important means meaningful user-facing or maintainer-facing behavior; minor means low-risk polish, cleanup, tests, or config; noise means mechanical churn that reviewers may safely scan last.",
      "When noise claims exist, group them in their own thread instead of mixing them with critical, important, or minor claims.",
      "When updating an existing thread, keep its thread id stable. Only create a new thread when the claim does not fit an existing area.",
      "Update existing claims before creating new ones.",
      "Do not create new claims for line movement, formatting, renames, or helper extraction unless meaning changed.",
      "Set agentStatus to one of: new, unchanged, evidence_moved, amended, invalidated, superseded.",
      "For unchanged claims, keep the existing thread title, thread summary, claim title, claim description, claim before, and claim after byte-for-byte. Only update evidence spans and evidence change lines if the code moved.",
      "Put every evidence span under the claim that depends on it. Use multiple files and ranges to cover the entire change.",
      "Evidence startLine/endLine are 1-based line numbers in the post-change file (HEAD). Copy them from the N| prefixes in touchedSnippets.text.",
      "Prefer multiple narrow evidence spans over one hunk-wide span when a claim depends on distinct changed regions. Use touchedSnippets.addedRanges as a guide for contiguous added-line groups.",
      "When a claim spans non-contiguous line ranges or files, add separate evidence objects under the same claim rather than one oversized range.",
      "Format human-facing thread title, thread summary, claim title, and claim description with Markdown.",
      "Keep claim titles short and direct.",
      "Use claim description only to add detail that complements the title; do not restate the same point.",
      "Aim for clarity with progressive disclosure: each new detail should build on the previous one and avoid repetition.",
      "When adding a claim to the review draft, write keys in this order: id, threadId, title, agentStatus, importance, humanStatus (if set), evidences, before, after, description — ground the claim in code spans first, then behavior deltas, then the longer description.",
      "On each claim, set optional before and after to high-level behavior summaries for the whole claim; use null when not applicable (pure addition: null before; pure removal: null after). Do not mention file paths or line numbers.",
      "On each evidence span, set change to a required imperative line describing what this span does; verb-first, concise, and may name symbols or APIs.",
    ],
  };
  const packetJson = JSON.stringify(packet, null, 2);
  const packetPath = await writeCurrentPacketExport(ctx, session, packetJson);
  const draft = buildReviewDraft(packet, packet.activeClaims);
  const draftJson = JSON.stringify(draft, null, 2);
  const draftPath = await writeReviewDraftExport(ctx, session, draftJson);
  if (!existing) {
    ctx.db
      .prepare(
        `insert into revisions (id, sessionId, number, state, gitFingerprint, packetArtifactId, packetJson, packetExportPath, resultPath, totalDiffArtifactId, createdAt, appliedAt)
         values (?, ?, ?, 'pending_agent', ?, null, ?, ?, ?, ?, ?, null)`,
      )
      .run(
        revisionId,
        session.id,
        number,
        git.fingerprint,
        packetJson,
        packetPath,
        draftPath,
        totalDiffArtifactId,
        Date.now(),
      );
  } else {
    ctx.db
      .prepare(
        "update revisions set packetJson = ?, packetExportPath = ?, resultPath = ?, totalDiffArtifactId = ? where id = ?",
      )
      .run(packetJson, packetPath, draftPath, totalDiffArtifactId, revisionId);
  }
  return {
    path: packetPath,
    draftPath,
    preview: draftPreview(packet, draftPath),
  };
}

async function writeArtifact(
  ctx: Context,
  kind: string,
  filename: string,
  contents: string,
) {
  const directory = join(ctx.artifactsDir, kind);
  ensurePrivateDirectory(directory);
  const path = join(directory, filename);
  await Bun.write(path, contents);
  ensurePrivateFile(path);
  return path;
}

function insertArtifactRef(db: Database, kind: string, path: string) {
  const id = `art_${crypto.randomUUID()}`;
  db.prepare(
    "insert into artifact_refs (id, kind, path, createdAt) values (?, ?, ?, ?)",
  ).run(id, kind, path, Date.now());
  return id;
}

function projectExportDirectory(ctx: Context, session: SessionRow) {
  return join(ctx.projectsDir, session.projectKey);
}

function clearProjectReviewExports(ctx: Context, session: SessionRow) {
  const directory = projectExportDirectory(ctx, session);
  for (const filename of [
    "agent-result.json",
    "current-packet.json",
    "review-draft.json",
  ]) {
    const path = join(directory, filename);
    if (existsSync(path)) unlinkSync(path);
  }
}

async function writeCurrentPacketExport(
  ctx: Context,
  session: SessionRow,
  packetJson: string,
) {
  const directory = projectExportDirectory(ctx, session);
  ensurePrivateDirectory(directory);
  const path = join(directory, "current-packet.json");
  await Bun.write(path, packetJson);
  ensurePrivateFile(path);
  return path;
}

async function writeReviewDraftExport(
  ctx: Context,
  session: SessionRow,
  draftJson: string,
) {
  const directory = projectExportDirectory(ctx, session);
  ensurePrivateDirectory(directory);
  const path = join(directory, "review-draft.json");
  await Bun.write(path, draftJson);
  ensurePrivateFile(path);
  return path;
}

function draftPreview(packet: Packet, draftPath: string) {
  return [
    `Draft: ${draftPath}`,
    `Packet: ${packet.packetId}`,
    `Revision: ${packet.revisionId} (#${packet.revisionNumber})`,
    `Fingerprint: ${packet.currentFingerprint}`,
    `Changed files: ${packet.changedFiles.length}`,
    ...packet.changedFiles
      .slice(0, 12)
      .map((file) => `- ${file.path} (+${file.additions}/-${file.deletions})`),
    ...(packet.changedFiles.length > 12
      ? [`- ... ${packet.changedFiles.length - 12} more`]
      : []),
  ].join("\n");
}

function parseStoredPacket(revision: RevisionRow) {
  if (!revision.packetJson) return null;
  return JSON.parse(revision.packetJson) as Packet;
}

function formatStatus(db: Database, session: SessionRow, git: GitState) {
  const lastApplied = getLastAppliedRevision(db, session.id);
  const pending = getPendingRevision(db, session.id);
  const burden = reviewBurden(db, session.id);
  const lines = [
    "Paire status",
    `Session: ${session.id}`,
    `Project: ${session.projectKey}`,
    `Base: ${session.baseRef} @ ${session.baseCommit}`,
    `Branch/upstream: ${git.branch}${git.upstream ? ` / ${git.upstream}` : " / (none)"}`,
    `Current git fingerprint: ${git.fingerprint}`,
    `Last applied Paire revision: ${lastApplied ? `${lastApplied.id} (${lastApplied.gitFingerprint})` : "(none)"}`,
    `Pending agent update: ${pending ? `${pending.id} (${pending.gitFingerprint})` : "(none)"}`,
    `Review burden: ${burden}`,
    git.clean
      ? "Suggested inspection: git diff --stat"
      : "Review blocked: Paire reviews committed code only. Commit worktree changes before running paire review.",
  ];
  if (pending?.packetJson) {
    lines.push(
      "",
      "Current review draft:",
      pending.resultPath ?? "(not exported)",
      "",
      "Current pending packet export:",
      pending.packetExportPath ?? "(not exported)",
    );
  }
  return lines.join("\n");
}

const AGENT_DIRTY_WORKTREE_ONE_LINER =
  "commit changes; paire it; and follow all the instructions to review and apply.";

function reviewActionRequiredMessage({
  diffFrom,
  diffFromLabel,
  lastAppliedId,
  packet,
}: {
  diffFrom: string;
  diffFromLabel: string;
  lastAppliedId: string | null;
  packet: { path: string; draftPath: string; preview: string };
}) {
  return [
    "Action required — update the Paire review",
    "",
    "Three steps. Done when step 3 exits 0.",
    "",
    "Step 1 — Inspect the diff",
    "Run and read:",
    `git diff ${diffFrom}..HEAD`,
    `(${diffFromLabel})`,
    lastAppliedId ? `Last applied Paire revision: ${lastAppliedId}` : "Last applied Paire revision: none",
    "",
    "Step 2 — Edit the review draft IN PLACE (do not create a new file)",
    packet.draftPath,
    "The draft is pre-filled: header IDs, every changed file under \"files\", and all prior",
    "claims (agentStatus \"unchanged\") are already correct.",
    "- Cover every \"files\" entry: reference it from a claim's evidences, or set its",
    "  disposition to \"acknowledged\" with a reason (mechanical/generated churn only).",
    "- Leave still-accurate prior claims exactly as listed. Never delete a prior claim.",
    "- Add new claims following context.claimTemplate; copy line numbers from the N|",
    "  prefixes in context.touchedSnippets. Follow the \"instructions\" in the draft.",
    "",
    "Step 3 — Apply",
    `paire review --apply ${packet.draftPath}`,
    "On failure it prints PAIRE_APPLY_REJECTED with a JSON list of exact fixes — edit the",
    "draft and re-run. On success the Review UI opens automatically.",
    packet.preview,
    "",
  ].join("\n");
}

function dirtyWorktreeMessage(git: GitState) {
  return [
    "PAIRE_NEEDS_COMMITTED_CHANGES",
    "",
    "Paire reviews committed code only.",
    "The current worktree has uncommitted changes, so Paire will not create a review packet from dirty files.",
    "Opening the existing review UI. It shows committed review state, not the latest worktree changes.",
    "",
    "Coding agent workflow — complete every step below in order. Do not skip steps.",
    "",
    "Step 1 — Commit worktree changes (required)",
    "Commit or stash your changes before running Paire.",
    "",
    "Step 2 — Run Paire again (required)",
    "Run: paire it",
    "(or: commit, then paire review)",
    "",
    "Step 3 — Follow every printed instruction through apply (required)",
    AGENT_DIRTY_WORKTREE_ONE_LINER,
    "When paire review prints Action required, complete all three steps through paire review --apply.",
    "Do not stop until apply succeeds; the Review UI opens automatically on success.",
    "",
    `Current branch: ${git.branch}`,
    `Current HEAD: ${git.head}`,
    "",
    "Safe inspection:",
    "`git status --short`",
    "`git diff --stat`",
  ].join("\n");
}

async function printStatusAndOpen(
  session: SessionRow,
  git: GitState,
  ctx: Context,
) {
  ctx.stdout(formatStatus(ctx.db, session, git));
  await openReviewUi(ctx, session, git);
}

function paireCliSpawnArgs(...args: string[]): string[] {
  if (import.meta.path.startsWith("/$bunfs/")) {
    return [process.execPath, ...args];
  }
  return [process.execPath, join(import.meta.dir, "../cli.ts"), ...args];
}

async function openReviewUi(ctx: Context, session: SessionRow, _git: GitState) {
  if (ctx.env.PAIRE_BROWSER_HTML_CAPTURE) {
    await Bun.write(
      ctx.env.PAIRE_BROWSER_HTML_CAPTURE,
      await Bun.file(join(import.meta.dir, "../local-app/index.html")).text(),
    );
  }

  if (ctx.env.PAIRE_BROWSER_CAPTURE) {
    const token = createReviewToken();
    const server = serveStandaloneReviewUi(session, ctx, token);
    const url = reviewUiUrl(server.port, token);
    await ctx.openBrowser(url);
    ctx.stdout(reviewUiMessage(url));
    server.stop();
    return;
  }

  const state = await ensureReviewServer(ctx, session);
  await ctx.openBrowser(state.url);
  ctx.stdout(reviewUiMessage(state.url));
}

// Ensure the shared daemon is up (spawning/upgrading as needed), register this
// session with it, and record the per-session URL/token. The daemon resolves
// requests back to a session via the per-session token.
async function ensureReviewServer(
  ctx: Context,
  session: SessionRow,
): Promise<ReviewServerState> {
  const daemon = await ensureReviewDaemon(ctx);
  const token = await registerReviewSession(daemon, session);
  const url = reviewUiUrl(daemon.port, token);
  const statePath = reviewServerStatePath(ctx, session.id);
  const state: ReviewServerState = {
    pid: daemon.pid,
    port: daemon.port,
    url,
    token,
    sessionId: session.id,
    repoRoot: session.repoRoot,
    startedAt: daemon.startedAt,
  };
  ensurePrivateDirectory(dirname(statePath));
  writeFileSync(statePath, JSON.stringify(state));
  ensurePrivateFile(statePath);
  return state;
}

async function ensureReviewDaemon(ctx: Context): Promise<ReviewDaemonState> {
  const statePath = reviewDaemonStatePath(ctx);
  const existing = readReviewDaemonState(statePath);
  if (
    existing &&
    isProcessRunning(existing.pid) &&
    (await isReviewDaemonAlive(existing))
  ) {
    if (existing.version === PAIRE_VERSION) {
      return existing;
    }
    // Version skew: an older daemon is still running stale code. Drain it so
    // the freshly-installed CLI serves its own code.
    await shutdownReviewDaemon(existing);
  }

  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
    } catch {
      // ignore
    }
  }

  Bun.spawn(paireCliSpawnArgs("_review-serve"), {
    cwd: ctx.cwd,
    env: { ...ctx.env, PAIRE_HOME: ctx.paireHome },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    detached: true,
  }).unref();

  return waitForReviewDaemonState(statePath);
}

async function registerReviewSession(
  daemon: ReviewDaemonState,
  session: SessionRow,
): Promise<string> {
  const response = await fetch(new URL("/api/_internal/register", daemon.baseUrl), {
    method: "POST",
    headers: {
      [REVIEW_TOKEN_HEADER]: daemon.adminToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.id, repoRoot: session.repoRoot }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error("Failed to register session with the review server.");
  }
  const data = (await response.json()) as { token?: unknown };
  if (typeof data.token !== "string") {
    throw new Error("Review server returned an invalid session token.");
  }
  return data.token;
}

// Unregister a session from the daemon and drop its per-session state file.
// "stopped" = handed off to a live daemon; "stale" = no live daemon, cleaned
// up the leftover file; "missing" = nothing was registered for this branch.
async function stopReviewSession(
  ctx: Context,
  session: SessionRow,
): Promise<"stopped" | "stale" | "missing"> {
  const statePath = reviewServerStatePath(ctx, session.id);
  if (!existsSync(statePath)) {
    return "missing";
  }

  const state = readReviewServerState(statePath);
  const daemon = readReviewDaemonState(reviewDaemonStatePath(ctx));
  const daemonAlive =
    !!daemon &&
    isProcessRunning(daemon.pid) &&
    (await isReviewDaemonAlive(daemon));

  try {
    unlinkSync(statePath);
  } catch {
    // ignore
  }

  if (state && daemon && daemonAlive) {
    try {
      await fetch(new URL("/api/_internal/unregister", daemon.baseUrl), {
        method: "POST",
        headers: {
          [REVIEW_TOKEN_HEADER]: daemon.adminToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: session.id }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // daemon may have exited between checks; the file is already gone
    }
    return "stopped";
  }

  return "stale";
}

// The long-lived shared review daemon: one process, one fixed port, routing
// requests to the right session by token. Exits when idle or when the last
// session unregisters.
async function reviewServeCommand(ctx: Context) {
  const statePath = reviewDaemonStatePath(ctx);
  const adminToken = createReviewToken();
  const registry = new Map<string, ReviewRegistryEntry>();
  const sessionTokens = new Map<string, string>();
  rehydrateReviewRegistry(ctx, registry, sessionTokens);

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };

  let server: ReturnType<typeof Bun.serve> | null = null;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server?.stop(true);
    } catch {
      // ignore
    }
    try {
      if (existsSync(statePath)) unlinkSync(statePath);
    } catch {
      // ignore
    }
    process.exit(0);
  };
  // Defer so the in-flight response flushes before the process exits.
  const queueShutdown = () => {
    setTimeout(shutdown, 10);
  };

  const resolveSession = (request: Request): SessionResolution => {
    touch();
    const token = request.headers.get(REVIEW_TOKEN_HEADER);
    const entry = token ? registry.get(token) : undefined;
    if (!entry) {
      return { error: "Unauthorized.", status: 401 };
    }
    const session = ctx.db
      .query<SessionRow, [string]>("select * from sessions where id = ?")
      .get(entry.sessionId);
    if (!session) {
      return { error: "Session not found.", status: 404 };
    }
    return { session };
  };

  const onRegister = async (request: Request) => {
    touch();
    const body = (await request.json()) as {
      sessionId?: unknown;
      repoRoot?: unknown;
    };
    if (typeof body.sessionId !== "string" || typeof body.repoRoot !== "string") {
      return Response.json({ error: "Invalid registration." }, { status: 400 });
    }
    let token = sessionTokens.get(body.sessionId);
    if (!token) {
      token = createReviewToken();
      sessionTokens.set(body.sessionId, token);
    }
    registry.set(token, { sessionId: body.sessionId, repoRoot: body.repoRoot });
    return Response.json({ token });
  };

  const onUnregister = async (request: Request) => {
    touch();
    const body = (await request.json()) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    const token = sessionTokens.get(body.sessionId);
    if (token) {
      registry.delete(token);
      sessionTokens.delete(body.sessionId);
    }
    const empty = sessionTokens.size === 0;
    if (empty) queueShutdown();
    return Response.json({ ok: true, empty });
  };

  const routes = buildReviewRoutes(ctx, resolveSession, {
    adminToken,
    onRegister,
    onUnregister,
    onShutdown: () => {
      queueShutdown();
      return Response.json({ ok: true });
    },
  });

  server = listenWithFallback((port) =>
    Bun.serve({ hostname: "127.0.0.1", port, routes }),
  );
  const port = server.port;
  if (port == null) {
    throw new Error("Review UI server did not bind to a port.");
  }

  writeFileSync(
    statePath,
    JSON.stringify({
      pid: process.pid,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      adminToken,
      version: PAIRE_VERSION,
      startedAt: Date.now(),
    } satisfies ReviewDaemonState),
  );
  ensurePrivateFile(statePath);

  const idle = setInterval(() => {
    if (Date.now() - lastActivity > REVIEW_IDLE_TIMEOUT_MS) {
      shutdown();
    }
  }, REVIEW_IDLE_CHECK_MS);
  idle.unref?.();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => undefined);
}

// Repopulate the daemon's session→token registry from the per-session state
// files written by the CLI, so browser tabs survive a daemon respawn.
function rehydrateReviewRegistry(
  ctx: Context,
  registry: Map<string, ReviewRegistryEntry>,
  sessionTokens: Map<string, string>,
) {
  const dir = join(ctx.paireHome, "review-servers");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const state = readReviewServerState(join(dir, name));
    if (!state) continue;
    registry.set(state.token, {
      sessionId: state.sessionId,
      repoRoot: state.repoRoot,
    });
    sessionTokens.set(state.sessionId, state.token);
  }
}

type ReviewAdminRoutes = {
  adminToken: string;
  onRegister: (request: Request) => Promise<Response> | Response;
  onUnregister: (request: Request) => Promise<Response> | Response;
  onShutdown: () => Response;
};

function buildReviewRoutes(
  ctx: Context,
  resolveSession: (request: Request) => SessionResolution,
  admin?: ReviewAdminRoutes,
) {
  const sessionRoute =
    (
      handler: (
        request: Request,
        session: SessionRow,
        ctx: Context,
      ) => Promise<Response> | Response,
    ) =>
    (request: Request) =>
      authenticatedReviewRequest(request, resolveSession, (session) =>
        handler(request, session, ctx),
      );

  const routes: Record<string, unknown> = {
    "/": reviewApp,
    "/api/review": sessionRoute(handleReviewRequest),
    "/api/review/diff": sessionRoute(handleReviewDiffRequest),
    "/api/claims/:claimId/evidence-diff": sessionRoute(
      handleEvidenceDiffRequest,
    ),
    "/api/claims/:claimId/human-status": sessionRoute(handleHumanStatusRequest),
    "/api/claims/:claimId/comment": sessionRoute(handleCommentRequest),
  };

  if (admin) {
    routes["/api/_internal/ping"] = (request: Request) =>
      adminReviewRequest(request, admin.adminToken, () =>
        Response.json({ ok: true, version: PAIRE_VERSION }),
      );
    routes["/api/_internal/register"] = (request: Request) =>
      adminReviewRequest(request, admin.adminToken, () =>
        admin.onRegister(request),
      );
    routes["/api/_internal/unregister"] = (request: Request) =>
      adminReviewRequest(request, admin.adminToken, () =>
        admin.onUnregister(request),
      );
    routes["/api/_internal/shutdown"] = (request: Request) =>
      adminReviewRequest(request, admin.adminToken, admin.onShutdown);
  }

  return routes as Bun.Serve.Routes<unknown, string>;
}

// A short-lived single-session server used only for browser-capture flows; it
// does not register with the daemon and is stopped immediately after use.
function serveStandaloneReviewUi(
  session: SessionRow,
  ctx: Context,
  token: string,
) {
  const routes = buildReviewRoutes(ctx, (request) => {
    if (request.headers.get(REVIEW_TOKEN_HEADER) !== token) {
      return { error: "Unauthorized.", status: 401 };
    }
    return { session };
  });
  return listenWithFallback((port) =>
    Bun.serve({ hostname: "127.0.0.1", port, routes }),
  );
}

function listenWithFallback(
  build: (port: number) => ReturnType<typeof Bun.serve>,
) {
  for (let attempt = 0; attempt < MAX_REVIEW_PORT_ATTEMPTS; attempt++) {
    const port = REVIEW_PORT + attempt;
    try {
      return build(port);
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
    }
  }
  const lastPort = REVIEW_PORT + MAX_REVIEW_PORT_ATTEMPTS - 1;
  throw new Error(
    `Could not bind review UI server on ports ${REVIEW_PORT}-${lastPort}.`,
  );
}

function isAddressInUseError(error: unknown) {
  return (
    error instanceof Error &&
    ("code" in error ? error.code === "EADDRINUSE" : false)
  );
}

function reviewServerStatePath(ctx: Context, sessionId: string) {
  return join(ctx.paireHome, "review-servers", `${sessionId}.json`);
}

function reviewDaemonStatePath(ctx: Context) {
  return join(ctx.paireHome, "review-server.json");
}

function readReviewServerState(path: string) {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewServerState>;
    if (
      typeof state.pid !== "number" ||
      typeof state.url !== "string" ||
      typeof state.token !== "string" ||
      typeof state.sessionId !== "string" ||
      typeof state.repoRoot !== "string"
    ) {
      return null;
    }
    return state as ReviewServerState;
  } catch {
    return null;
  }
}

function readReviewDaemonState(path: string) {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ReviewDaemonState>;
    if (
      typeof state.pid !== "number" ||
      typeof state.port !== "number" ||
      typeof state.baseUrl !== "string" ||
      typeof state.adminToken !== "string" ||
      typeof state.version !== "string"
    ) {
      return null;
    }
    return state as ReviewDaemonState;
  } catch {
    return null;
  }
}

async function waitForReviewDaemonState(path: string) {
  const deadline = Date.now() + REVIEW_SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readReviewDaemonState(path);
    if (state && isProcessRunning(state.pid) && (await isReviewDaemonAlive(state))) {
      return state;
    }
    await Bun.sleep(50);
  }
  throw new Error("Review UI server failed to start.");
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isReviewDaemonAlive(
  state: Pick<ReviewDaemonState, "baseUrl" | "adminToken">,
) {
  try {
    const response = await fetch(new URL("/api/_internal/ping", state.baseUrl), {
      headers: { [REVIEW_TOKEN_HEADER]: state.adminToken },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function shutdownReviewDaemon(state: ReviewDaemonState) {
  try {
    await fetch(new URL("/api/_internal/shutdown", state.baseUrl), {
      method: "POST",
      headers: { [REVIEW_TOKEN_HEADER]: state.adminToken },
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // fall through to signal-based shutdown
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && isProcessRunning(state.pid)) {
    await Bun.sleep(50);
  }
  if (isProcessRunning(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already exited
    }
    const killDeadline = Date.now() + 1_000;
    while (Date.now() < killDeadline && isProcessRunning(state.pid)) {
      await Bun.sleep(50);
    }
  }
}

function createReviewToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(REVIEW_TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function reviewUiUrl(port: number | undefined, token: string) {
  if (port == null) {
    throw new Error("Review UI server did not bind to a port.");
  }
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
}

function reviewUiMessage(url: string) {
  return [`Review UI: ${url}`, `Open this URL in the browser: ${url}`].join(
    "\n",
  );
}

function authenticatedReviewRequest(
  request: Request,
  resolveSession: (request: Request) => SessionResolution,
  handler: (session: SessionRow) => Promise<Response> | Response,
) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "http://127.0.0.1",
        "Access-Control-Allow-Headers": REVIEW_TOKEN_HEADER,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      },
    });
  }
  const resolved = resolveSession(request);
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }
  return handler(resolved.session);
}

function adminReviewRequest(
  request: Request,
  adminToken: string,
  handler: () => Promise<Response> | Response,
) {
  if (request.headers.get(REVIEW_TOKEN_HEADER) !== adminToken) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return handler();
}

async function handleReviewRequest(
  request: Request,
  session: SessionRow,
  ctx: Context,
) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const freshSession = ctx.db
    .query<SessionRow, [string]>("select * from sessions where id = ?")
    .get(session.id);
  if (!freshSession) {
    return Response.json({ error: "Session not found." }, { status: 404 });
  }
  return Response.json(
    buildReviewData(ctx.db, freshSession, getGitState(freshSession.repoRoot)),
  );
}

async function handleHumanStatusRequest(
  request: Request,
  session: SessionRow,
  ctx: Context,
) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const claimId = (request as Request & { params: { claimId: string } }).params
    .claimId;
  const claimDbId = scopedDbId(session.id, claimId);
  const payload = (await request.json()) as { humanStatus?: unknown };
  if (
    typeof payload.humanStatus !== "string" ||
    !VALID_HUMAN_STATUSES.has(payload.humanStatus)
  ) {
    return Response.json({ error: "Invalid humanStatus." }, { status: 400 });
  }
  const update = ctx.db
    .prepare(
      "update claims set humanStatus = ?, updatedAt = ? where id = ? and sessionId = ?",
    )
    .run(payload.humanStatus, Date.now(), claimDbId, session.id);
  if (update.changes === 0) {
    return Response.json({ error: "Claim not found." }, { status: 404 });
  }
  ctx.db
    .prepare(
      "insert into human_review_marks (id, claimId, humanStatus, note, updatedAt) values (?, ?, ?, null, ?)",
    )
    .run(
      `mark_${crypto.randomUUID()}`,
      claimDbId,
      payload.humanStatus,
      Date.now(),
    );
  return Response.json({ ok: true });
}

async function handleEvidenceDiffRequest(
  request: Request,
  session: SessionRow,
  ctx: Context,
) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const claimId = (request as Request & { params: { claimId: string } }).params
    .claimId;
  const filePath = new URL(request.url).searchParams.get("filePath");
  if (!filePath) {
    return Response.json({ error: "Missing filePath." }, { status: 400 });
  }

  const claimDbId = scopedDbId(session.id, claimId);
  const evidence = ctx.db
    .query<{ filePath: string }, [string, string, string]>(
      `select claim_evidences.filePath
         from claim_evidences
         join claims on claims.id = claim_evidences.claimId
        where claims.id = ?
          and claims.sessionId = ?
          and claim_evidences.filePath = ?
        limit 1`,
    )
    .get(claimDbId, session.id, filePath);
  if (!evidence) {
    return Response.json({ error: "Evidence not found." }, { status: 404 });
  }

  const totalDiff = gitDiffForCurrentState(
    session.baseCommit,
    session.repoRoot,
    true,
  );
  return Response.json({ diff: fileToRawDiff(totalDiff, evidence.filePath) });
}

async function handleReviewDiffRequest(
  request: Request,
  session: SessionRow,
  _ctx: Context,
) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  return Response.json({
    diff: gitDiffForCurrentState(session.baseCommit, session.repoRoot, true),
  });
}

async function handleCommentRequest(
  request: Request,
  session: SessionRow,
  ctx: Context,
) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const claimId = (request as Request & { params: { claimId: string } }).params
    .claimId;
  const claimDbId = scopedDbId(session.id, claimId);
  const payload = (await request.json()) as { note?: unknown };
  if (typeof payload.note !== "string" || !payload.note.trim()) {
    return Response.json({ error: "Invalid comment." }, { status: 400 });
  }
  if (payload.note.length > MAX_COMMENT_CHARS) {
    return Response.json({ error: "Comment is too long." }, { status: 400 });
  }
  const claim = ctx.db
    .query<{ humanStatus: HumanStatus }, [string, string]>(
      "select humanStatus from claims where id = ? and sessionId = ?",
    )
    .get(claimDbId, session.id);
  if (!claim) {
    return Response.json({ error: "Claim not found." }, { status: 404 });
  }
  ctx.db
    .prepare(
      "insert into human_review_marks (id, claimId, humanStatus, note, updatedAt) values (?, ?, ?, ?, ?)",
    )
    .run(
      `mark_${crypto.randomUUID()}`,
      claimDbId,
      claim.humanStatus,
      payload.note.trim(),
      Date.now(),
    );
  return Response.json({ ok: true });
}

function buildReviewData(db: Database, session: SessionRow, git: GitState) {
  const threads = db
    .query<
      { id: string; title: string; summary: string },
      [string]
    >(
      "select id, title, summary from change_threads where sessionId = ? order by updatedAt desc, rowid desc",
    )
    .all(session.id)
    .map((thread) => ({
      ...thread,
      id: publicDbId(session.id, thread.id),
      claims: getClaimsForThread(db, session.id, thread.id),
    }))
    .sort(compareThreadsByImportance);
  return {
    session,
    git,
    burden: reviewBurden(db, session.id),
    generatedAt: Date.now(),
    threads,
  };
}

function getClaimsForThread(
  db: Database,
  sessionId: string,
  threadDbId: string,
) {
  return db
    .query<StoredAgentClaim, [string]>(
      "select id, threadId, title, description, beforeText as before, afterText as after, agentStatus, importance, humanStatus, updatedAt from claims where threadId = ? order by updatedAt desc, rowid desc",
    )
    .all(threadDbId)
    .sort(compareClaimsByImportance)
    .map((claim) => ({
      ...claim,
      ...normalizeStoredClaim(claim),
      id: publicDbId(sessionId, claim.id),
      threadId: publicDbId(sessionId, claim.threadId),
      evidences: db
        .query<
        AgentEvidence & { revisionId: string },
        [string]
      >("select filePath, startLine, endLine, symbol, fingerprint, revisionId, changeText as change from claim_evidences where claimId = ? order by filePath, startLine")
        .all(claim.id)
        .map((evidence) => ({
          ...evidence,
          claimId: publicDbId(sessionId, claim.id),
        })),
    }));
}

function compareClaimsByImportance(
  left: Pick<StoredAgentClaim, "importance">,
  right: Pick<StoredAgentClaim, "importance">,
) {
  return (
    CLAIM_IMPORTANCE_RANK[left.importance] -
    CLAIM_IMPORTANCE_RANK[right.importance]
  );
}

function compareThreadsByImportance(
  left: { claims: Array<Pick<StoredAgentClaim, "importance">> },
  right: { claims: Array<Pick<StoredAgentClaim, "importance">> },
) {
  const leftCounts = claimImportanceCounts(left.claims);
  const rightCounts = claimImportanceCounts(right.claims);
  for (const importance of CLAIM_IMPORTANCE_ORDER) {
    const countDelta = rightCounts[importance] - leftCounts[importance];
    if (countDelta !== 0) return countDelta;
  }
  return 0;
}

function claimImportanceCounts(claims: Array<Pick<StoredAgentClaim, "importance">>) {
  const counts: Record<ClaimImportance, number> = {
    critical: 0,
    important: 0,
    minor: 0,
    noise: 0,
  };
  for (const claim of claims) counts[claim.importance] += 1;
  return counts;
}

async function openBrowser(
  url: string,
  env: Record<string, string | undefined>,
) {
  if (env.PAIRE_BROWSER_CAPTURE) {
    const captureFile = Bun.file(env.PAIRE_BROWSER_CAPTURE);
    const existing = await captureFile.exists() ? await captureFile.text() : "";
    await Bun.write(env.PAIRE_BROWSER_CAPTURE, `${existing}${url}\n`);
    return;
  }
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];
  Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
}

function ensurePrivateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort for non-POSIX filesystems.
  }
}

function ensurePrivateFile(path: string) {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort for non-POSIX filesystems.
  }
}

function migrate(db: Database) {
  db.exec(`
    create table if not exists sessions (
      id text primary key,
      repoRoot text not null,
      projectKey text not null,
      goal text,
      baseRef text not null,
      baseCommit text not null,
      branch text not null,
      upstream text,
      createdAt integer not null,
      updatedAt integer not null,
      unique(repoRoot, branch)
    );
    create table if not exists revisions (
      id text primary key,
      sessionId text not null,
      number integer not null,
      state text not null,
      gitFingerprint text not null,
      packetArtifactId text,
      packetJson text,
      packetExportPath text,
      resultPath text,
      totalDiffArtifactId text,
      createdAt integer not null,
      appliedAt integer
    );
    create table if not exists change_threads (
      id text primary key,
      sessionId text not null,
      title text not null,
      summary text not null,
      updatedAt integer not null
    );
    create table if not exists claims (
      id text primary key,
      threadId text not null,
      sessionId text not null,
      title text not null,
      description text not null default '',
      beforeText text,
      afterText text,
      agentStatus text not null,
      importance text not null default 'minor',
      humanStatus text not null,
      updatedAt integer not null
    );
    create table if not exists claim_evidences (
      id text primary key,
      claimId text not null,
      revisionId text not null,
      filePath text not null,
      startLine integer not null,
      endLine integer not null,
      symbol text,
      fingerprint text,
      changeText text
    );
    create table if not exists claim_revisions (
      id text primary key,
      claimId text not null,
      sessionId text not null,
      revisionId text not null,
      agentStatus text not null,
      title text not null,
      description text not null default '',
      beforeText text,
      afterText text,
      importance text not null,
      evidencesJson text not null,
      createdAt integer not null
    );
    create table if not exists human_review_marks (
      id text primary key,
      claimId text not null,
      humanStatus text not null,
      note text,
      updatedAt integer not null
    );
    create table if not exists artifact_refs (
      id text primary key,
      kind text not null,
      path text not null,
      createdAt integer not null
    );
  `);
}

function getSession(db: Database, repoRoot: string, branch: string) {
  return db
    .query<SessionRow, [string, string]>(
      "select * from sessions where repoRoot = ? and branch = ?",
    )
    .get(repoRoot, branch);
}

function insertAppliedBaselineRevision(
  db: Database,
  sessionId: string,
  gitFingerprint: string,
  timestamp: number,
) {
  db.prepare(
    `insert into revisions (id, sessionId, number, state, gitFingerprint, packetArtifactId, packetJson, packetExportPath, resultPath, totalDiffArtifactId, createdAt, appliedAt)
     values (?, ?, ?, 'applied', ?, null, null, null, null, null, ?, ?)`,
  ).run(
    `rev_${crypto.randomUUID()}`,
    sessionId,
    0,
    gitFingerprint,
    timestamp,
    timestamp,
  );
}

function getLastAppliedRevision(db: Database, sessionId: string) {
  return db
    .query<
      RevisionRow,
      [string]
    >("select * from revisions where sessionId = ? and state = 'applied' order by number desc limit 1")
    .get(sessionId);
}

function getPendingRevision(db: Database, sessionId: string) {
  return db
    .query<
      RevisionRow,
      [string]
    >("select * from revisions where sessionId = ? and state = 'pending_agent' order by createdAt desc limit 1")
    .get(sessionId);
}

function nextRevisionNumber(db: Database, sessionId: string) {
  const row = db
    .query<
      { value: number },
      [string]
    >("select coalesce(max(number), 0) + 1 as value from revisions where sessionId = ?")
    .get(sessionId);
  return row?.value ?? 1;
}

function reviewBurden(db: Database, sessionId: string) {
  const rows = db
    .query<
      { agentStatus: string; count: number },
      [string]
    >("select agentStatus, count(*) as count from claims where sessionId = ? group by agentStatus order by agentStatus")
    .all(sessionId);
  if (rows.length === 0) return "0 claims";
  return rows.map((row) => `${row.count} ${row.agentStatus}`).join(", ");
}

function appendClaimRevision(
  db: Database,
  snapshot: {
    claimId: string;
    sessionId: string;
    revisionId: string;
    agentStatus: ClaimStatus;
    title: string;
    description: string;
    beforeText: string | null;
    afterText: string | null;
    importance: ClaimImportance;
    evidences: AgentEvidence[];
    createdAt: number;
  },
) {
  db.prepare(
    `insert into claim_revisions (
      id, claimId, sessionId, revisionId, agentStatus, title, description,
      beforeText, afterText, importance, evidencesJson, createdAt
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `cr_${crypto.randomUUID()}`,
    snapshot.claimId,
    snapshot.sessionId,
    snapshot.revisionId,
    snapshot.agentStatus,
    snapshot.title,
    snapshot.description,
    snapshot.beforeText,
    snapshot.afterText,
    snapshot.importance,
    JSON.stringify(snapshot.evidences),
    snapshot.createdAt,
  );
}

export function getClaimHistory(db: Database, claimId: string) {
  return db
    .query<ClaimRevisionRow, [string]>(
      "select * from claim_revisions where claimId = ? order by createdAt asc, rowid asc",
    )
    .all(claimId);
}

function getActiveClaims(db: Database, sessionId: string) {
  const rows = db
    .query<StoredAgentClaim & { threadTitle: string }, [string]>(
      `select claims.id, claims.threadId, claims.title, claims.description,
              claims.beforeText as before, claims.afterText as after,
              claims.agentStatus, claims.importance, claims.humanStatus, change_threads.title as threadTitle
       from claims join change_threads on change_threads.id = claims.threadId
       where claims.sessionId = ? and claims.agentStatus not in ('superseded', 'invalidated')
       order by change_threads.updatedAt desc, change_threads.rowid desc, claims.updatedAt desc, claims.rowid desc`,
    )
    .all(sessionId);
  return rows.map((claim) =>
    formatAgentClaimForExport({
      ...claim,
      ...normalizeStoredClaim(claim),
      id: publicDbId(sessionId, claim.id),
      threadId: publicDbId(sessionId, claim.threadId),
      evidences: db
        .query<
        AgentEvidence & { revisionId: string },
        [string]
      >(
        "select filePath, startLine, endLine, symbol, fingerprint, revisionId, changeText as change from claim_evidences where claimId = ? order by filePath, startLine",
      )
        .all(claim.id),
    }),
  );
}

function formatAgentClaimForExport<T extends AgentClaim & { threadTitle?: string }>(
  claim: T,
): T {
  const { threadTitle, ...rest } = claim;
  const formatted: AgentClaim & { threadTitle?: string } = {
    id: rest.id,
    threadId: rest.threadId,
    title: rest.title,
    agentStatus: rest.agentStatus,
    importance: rest.importance,
    ...(rest.humanStatus != null ? { humanStatus: rest.humanStatus } : {}),
    evidences: rest.evidences,
    before: rest.before ?? null,
    after: rest.after ?? null,
    ...(rest.description?.trim() ? { description: rest.description.trim() } : {}),
    ...(rest.updatedAt != null ? { updatedAt: rest.updatedAt } : {}),
  };
  if (threadTitle != null) {
    formatted.threadTitle = threadTitle;
  }
  return formatted as T;
}

function scopedDbId(sessionId: string, publicId: string) {
  return `${sessionId}:${publicId}`;
}

function publicDbId(sessionId: string, dbId: string) {
  const prefix = `${sessionId}:`;
  return dbId.startsWith(prefix) ? dbId.slice(prefix.length) : dbId;
}

function normalizeNullableCopy(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requiredClaimCopy(claim: AgentClaim) {
  if (!claim.title) {
    throw new Error(`Validated claim ${claim.id} is missing title.`);
  }
  return {
    title: claim.title,
    description: claim.description,
  };
}

function finalClaimCopy(
  claim: AgentClaim,
  existingClaim: { title: string; description: string } | null | undefined,
  preserveClaimCopy: boolean,
) {
  if (preserveClaimCopy && existingClaim) {
    return {
      title: existingClaim.title,
      description: existingClaim.description,
    };
  }
  return normalizeClaimCopy(requiredClaimCopy(claim));
}

function canPreserveExistingThreadCopy(claim: AgentClaim) {
  return (
    claim.agentStatus === "unchanged" ||
    claim.agentStatus === "evidence_moved" ||
    claim.agentStatus === "invalidated" ||
    claim.agentStatus === "superseded"
  );
}

function canPreserveExistingClaimCopy(claim: AgentClaim) {
  return (
    claim.agentStatus === "unchanged" ||
    ((claim.agentStatus === "evidence_moved" ||
      claim.agentStatus === "invalidated" ||
      claim.agentStatus === "superseded") &&
      !claim.title)
  );
}

function canPreserveExistingEvidenceRows(agentStatus: ClaimStatus) {
  return (
    agentStatus === "unchanged" ||
    agentStatus === "invalidated" ||
    agentStatus === "superseded"
  );
}

function requiredImportance(claim: AgentClaim) {
  if (!claim.importance) {
    throw new Error(`Validated claim ${claim.id} is missing importance.`);
  }
  return claim.importance;
}

function normalizeClaimCopy(claim: Pick<AgentClaim, "title" | "description">) {
  if (!claim.title) {
    throw new Error("Validated claim copy is missing title.");
  }
  return {
    title: claim.title.trim(),
    description: claim.description ? claim.description.trim() : "",
  };
}

function normalizeStoredClaim(
  claim: Pick<AgentClaim, "title" | "description">,
) {
  const copy = normalizeClaimCopy(claim);
  return {
    title: copy.title,
    description: copy.description,
  };
}

function getGitRepoRoot(cwd: string): string {
  return gitCommand(["rev-parse", "--show-toplevel"], cwd).trim();
}

function getGitState(cwd: string): GitState {
  const repoRoot = getGitRepoRoot(cwd);
  const branch = gitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot,
  ).trim();
  const upstream =
    gitCommand(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      repoRoot,
      {
        allowFail: true,
      },
    ).trim() || null;
  const head = gitCommand(["rev-parse", "HEAD"], repoRoot).trim();
  const status = gitCommand(["status", "--porcelain"], repoRoot);
  const clean = status.trim().length === 0;
  const fingerprint = head;
  return { repoRoot, branch, upstream, head, clean, fingerprint, status };
}

function detectProjectKey(repoRoot: string) {
  const origin = gitCommand(["config", "--get", "remote.origin.url"], repoRoot, {
    allowFail: true,
  }).trim();
  const github = parseGitHubRemote(origin);
  const rootHash = hashForPath(repoRoot);
  if (github) {
    return ["github", sanitizePathPart(github.owner), sanitizePathPart(github.repo), rootHash].join(
      "/",
    );
  }
  return ["local", sanitizePathPart(repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? "repo"), rootHash].join(
    "/",
  );
}

function parseGitHubRemote(remote: string) {
  if (!remote) return null;
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(
    remote,
  );
  if (https) return { owner: https[1] ?? "", repo: https[2] ?? "" };
  const ssh = /^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/.exec(remote);
  if (ssh) return { owner: ssh[1] ?? "", repo: ssh[2] ?? "" };
  return null;
}

function sanitizePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "unknown";
}

function hashForPath(value: string) {
  return new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

function gitDiffBaseRef(fingerprint: string) {
  const dirtyMarker = ":dirty:";
  const markerIndex = fingerprint.indexOf(dirtyMarker);
  if (markerIndex >= 0) return fingerprint.slice(0, markerIndex);
  return fingerprint;
}

function gitDiffForCurrentState(
  base: string,
  repoRoot: string,
  allowFail = false,
) {
  return gitCommand(
    ["diff", "-w", `${gitDiffBaseRef(base)}..HEAD`],
    repoRoot,
    {
      allowFail,
    },
  );
}

function gitCommand(
  args: string[],
  cwd: string,
  options: { allowFail?: boolean } = {},
) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0 && !options.allowFail) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return stdout;
}

function detectBaseRef(repoRoot: string) {
  const candidates = [
    "origin/main",
    "origin/master",
    "origin/develop",
    "main",
    "master",
    "develop",
  ];
  for (const candidate of candidates) {
    if (
      gitCommand(["rev-parse", "--verify", candidate], repoRoot, {
        allowFail: true,
      }).trim()
    ) {
      return candidate;
    }
  }
  return "HEAD";
}

function summarizeChangedFiles(diff: string): ChangedFile[] {
  try {
    const patches = parsePatchFiles(diff, "paire", false);
    const files = patches.flatMap((patch) => patch.files);
    return files.map((file) => {
      const fileDiff = fileToRawDiff(diff, file.name);
      return {
        path: file.name,
        additions: file.hunks.reduce(
          (sum, hunk) => sum + hunk.additionLines,
          0,
        ),
        deletions: file.hunks.reduce(
          (sum, hunk) => sum + hunk.deletionLines,
          0,
        ),
        summarized: shouldSummarizeFile(file.name, fileDiff),
      };
    });
  } catch {
    return parseChangedFilesFallback(diff);
  }
}

function touchedSnippets(diff: string): TouchedSnippet[] {
  let total = 0;
  const snippets: TouchedSnippet[] = [];
  try {
    const patches = parsePatchFiles(diff, "paire-snippet", false);
    for (const file of patches.flatMap((patch) => patch.files)) {
      const raw = fileToRawDiff(diff, file.name);
      const summarize = shouldSummarizeFile(file.name, raw);
      for (const hunk of file.hunks) {
        if (total > MAX_TOTAL_SNIPPET_CHARS) break;
        const rawHunk = rawHunkText(raw, hunk.hunkSpecs ?? "");
        const annotated = summarize
          ? null
          : annotateHunkText(
              rawHunk,
              hunk.additionStart,
              hunk.deletionStart,
            );
        const text = annotated
          ? annotated.annotatedText.slice(0, MAX_INLINE_SNIPPET_CHARS)
          : `[summarized: ${file.name} is too large or generated; inspect the artifact diff path instead]`;
        total += text.length;
        snippets.push({
          filePath: file.name,
          startLine: hunk.additionStart,
          endLine: Math.max(
            hunk.additionStart,
            hunk.additionStart + hunk.additionCount - 1,
          ),
          hunkHeader: hunk.hunkSpecs,
          text,
          addedRanges: annotated ? addedLineRanges(annotated.lines) : undefined,
          summarized: summarize,
        });
      }
    }
  } catch {
    return [];
  }
  return snippets;
}

function shouldSummarizeFile(path: string, rawDiff: string) {
  return (
    rawDiff.length > LARGE_DIFF_BYTES ||
    /(^|\/)(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml)$/.test(
      path,
    ) ||
    /\.(min\.js|map|snap)$/.test(path) ||
    /(^|\/)(dist|build|coverage)\//.test(path)
  );
}

function fileToRawDiff(diff: string, filePath: string) {
  const marker = `diff --git `;
  const chunks = diff
    .split(`\n${marker}`)
    .map((chunk, index) => (index === 0 ? chunk : `${marker}${chunk}`));
  return (
    chunks.find(
      (chunk) =>
        chunk.includes(` b/${filePath}\n`) ||
        chunk.includes(` b/${filePath}\r\n`),
    ) ?? ""
  );
}

function rawHunkText(raw: string, hunkHeader: string) {
  if (!hunkHeader) return raw;
  const start = raw.indexOf(hunkHeader);
  if (start < 0) return raw;
  const next = raw.indexOf("\n@@", start + hunkHeader.length);
  return raw.slice(start, next < 0 ? undefined : next);
}

function parseChangedFilesFallback(diff: string): ChangedFile[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = match?.[2] ?? line;
      return {
        path,
        additions: 0,
        deletions: 0,
        summarized: shouldSummarizeFile(path, ""),
      };
    });
}

function parseFlags(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (name === "stdin" || name === "no-open") {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      flags.add(name);
    } else {
      values.set(name, value);
      index += 1;
    }
  }
  return { values, flags };
}

function stringFlag(parsed: ReturnType<typeof parseFlags>, name: string) {
  return parsed.values.get(name);
}

function resolveRequiredPath(path: string | undefined, message: string) {
  if (!path) throw new Error(message);
  return resolve(path);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function helpText() {
  return [
    "Usage: paire <command>",
    "",
    "Commands:",
    "  start --base <ref> --goal <text>",
    "  review [--apply <file> | --check <file> | --stdin] [--no-open]",
    "  it",
    "  status",
    "  sync",
    "  reset",
    "  server start [--no-open]",
    "  server stop",
    "  install",
    "  version",
  ].join("\n");
}

function serverHelpText() {
  return [
    "Usage: paire server <command>",
    "",
    "Commands:",
    "  start [--no-open]   Start or reuse the review UI server for the current branch",
    "  stop                Stop the review UI server for the current branch",
  ].join("\n");
}
