import { parsePatchFiles } from "@pierre/diffs";
import { Database } from "bun:sqlite";

import { addedLineRanges, annotateHunkText } from "./diff-line-numbers";
import {
  checkCoverage,
  checkEvidenceSpans,
  checkPriorClaims,
  formatRejection,
  validateApplyPayload,
  validateWorktreeApplyPayload,
  type AgentApplyPayload,
  type AgentClaim,
  type AgentEvidence,
  type AgentThread,
  type AgentWorktreeApplyPayload,
  type ApplyIssue,
  type ClaimImportance,
  type ClaimStatus,
  type HumanStatus,
} from "./apply-validation";
import {
  buildReviewDraft,
  buildWorktreeReviewDraft,
  stripDraftAnnotations,
  type WorktreeDraftPacket,
} from "./review-draft";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
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
import {
  PAIRE_INSTALL_PIPELINE,
  getLatestVersionCached,
  upgradeAvailable,
  upgradeNotice,
} from "./upgrade";
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

type WorktreeReviewRow = {
  id: string;
  sessionId: string;
  worktreeHash: string;
  gitHead: string;
  state: "pending_agent" | "applied";
  packetJson: string | null;
  draftPath: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  appliedAt: number | null;
};

type WorktreePacket = {
  packetId: string;
  sessionId: string;
  projectKey: string;
  worktreeReviewId: string;
  worktreeHash: string;
  gitHead: string;
  goal: string | null;
  changedFiles: ChangedFile[];
  skipped: string[];
  touchedSnippets: TouchedSnippet[];
  activeClaims: Array<AgentClaim & { threadTitle: string }>;
  safeInspectionCommands: string[];
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
  annotatedDiffPath: string;
  touchedSnippets: TouchedSnippet[];
  touchedRanges: TouchedRange[];
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

type TouchedRange = {
  filePath: string;
  ranges: Array<{ startLine: number; endLine: number }>;
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
const REVIEW_IDLE_TIMEOUT_MS = 16 * 60 * 60_000;
const REVIEW_IDLE_CHECK_MS = 60_000;
const MAX_WORKTREE_PREVIEW_FILE_BYTES = 1_000_000;

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
      case "worktree":
        return await worktreeCommand(rest, ctx);
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
      case "upgrade":
        return await upgradeCommand(rest, ctx);
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
  const open = parsed.flags.has("open");
  if (applyPath || parsed.flags.has("stdin")) {
    return await applyReviewCommand(
      applyPath,
      parsed.flags.has("stdin"),
      open,
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
    const draft = await createWorktreeReviewDraft(ctx, session, git);
    ctx.stdout(worktreeActionRequiredMessage({ git, draft }));
    await openReviewUi(ctx, session, git, open);
    return 0;
  }
  const lastApplied = getLastAppliedRevision(ctx.db, session.id);
  if (lastApplied?.gitFingerprint === git.fingerprint) {
    await printStatusAndOpen(session, git, ctx, open);
    return 0;
  }

  const packet = await createPendingPacket(ctx, session, git, lastApplied);
  const diffFrom = lastApplied?.gitFingerprint ?? session.baseCommit;
  const diffFromLabel = lastApplied
    ? `last applied commit ${diffFrom}`
    : `base commit ${diffFrom}`;
  ctx.stdout(
    reviewActionRequiredMessage({
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
  const open = parseFlags(args).flags.has("open");
  await reviewCommand(open ? ["--open"] : [], ctx);
  await maybePrintUpgradeNotice(ctx);
}

function upgradeCachePath(ctx: Context) {
  return join(ctx.paireHome, "upgrade-check.json");
}

/**
 * Print a one-line upgrade hint at the end of `paire it` when a newer release
 * exists. Best effort: cached, short-timeout, and never fails the command.
 * Opt out with PAIRE_NO_UPGRADE_CHECK=1.
 */
async function maybePrintUpgradeNotice(ctx: Context) {
  if (ctx.env.PAIRE_NO_UPGRADE_CHECK === "1") return;
  // Dev builds never report an upgrade, so skip the network check entirely.
  if (PAIRE_VERSION === "dev") return;
  try {
    const latest = await getLatestVersionCached({
      cachePath: upgradeCachePath(ctx),
      env: ctx.env,
    });
    if (upgradeAvailable(PAIRE_VERSION, latest)) {
      ctx.stdout(`\n${upgradeNotice(latest)}`);
    }
  } catch {
    // Upgrade checks are advisory; ignore any failure.
  }
}

async function upgradeCommand(args: string[], ctx: Context): Promise<number> {
  const parsed = parseFlags(args);
  const force = parsed.flags.has("force");
  const latest = await getLatestVersionCached({
    cachePath: upgradeCachePath(ctx),
    env: ctx.env,
    ttlMs: 0,
  });
  if (latest && !force && !upgradeAvailable(PAIRE_VERSION, latest)) {
    ctx.stdout(`paire is already up to date (${PAIRE_VERSION}).`);
    return 0;
  }
  ctx.stdout(
    latest
      ? `Upgrading paire ${PAIRE_VERSION} -> ${latest}...`
      : "Upgrading paire to the latest version...",
  );
  const result = Bun.spawnSync(["bash", "-c", PAIRE_INSTALL_PIPELINE], {
    cwd: ctx.cwd,
    env: ctx.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  if (result.exitCode !== 0) {
    ctx.stderr(`paire upgrade failed (exit code ${result.exitCode}).`);
    return result.exitCode || 1;
  }
  return 0;
}

async function applyReviewCommand(
  applyPath: string | undefined,
  useStdin: boolean,
  open: boolean,
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
  await openReviewUi(ctx, session, git, open);
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

const WORKTREE_APPLY_COMMAND = "paire worktree --apply";

async function worktreeCommand(args: string[], ctx: Context): Promise<number> {
  const parsed = parseFlags(args);
  const applyPath = stringFlag(parsed, "apply");
  const checkPath = stringFlag(parsed, "check");
  const open = parsed.flags.has("open");
  if (applyPath || parsed.flags.has("stdin")) {
    return await applyWorktreeReviewCommand(
      applyPath,
      parsed.flags.has("stdin"),
      open,
      ctx,
    );
  }
  if (checkPath) {
    return await checkWorktreeReviewCommand(checkPath, ctx);
  }
  ctx.stderr(
    "Usage: paire worktree --apply <file> | --check <file> [--open]\nRun paire it on a dirty worktree to generate the worktree review draft first.",
  );
  return 1;
}

type ReadyWorktreeApply = {
  payload: AgentWorktreeApplyPayload;
  session: SessionRow;
  git: GitState;
  review: WorktreeReviewRow;
  packet: WorktreePacket;
  priorPayload: AgentWorktreeApplyPayload | null;
};

async function applyWorktreeReviewCommand(
  applyPath: string | undefined,
  useStdin: boolean,
  open: boolean,
  ctx: Context,
) {
  const draftPath = useStdin
    ? "(stdin)"
    : resolveRequiredPath(applyPath, "Missing --apply file.");
  const result = await validateWorktreeReviewDraft(draftPath, useStdin, ctx);
  if (result.issues.length > 0 || !result.ready) {
    ctx.stderr(formatRejection(draftPath, result.issues, WORKTREE_APPLY_COMMAND));
    return 1;
  }
  const { payload, session, git, review, priorPayload } = result.ready;
  const merged = mergeWorktreePayload(priorPayload, payload);
  const now = Date.now();
  ctx.db
    .prepare(
      "update worktree_reviews set state = 'applied', payloadJson = ?, gitHead = ?, updatedAt = ?, appliedAt = ? where id = ?",
    )
    .run(JSON.stringify(merged), payload.gitHead, now, now, review.id);
  ctx.stdout(formatWorktreeStatus(session, git, merged));
  await openReviewUi(ctx, session, git, open);
  return 0;
}

async function checkWorktreeReviewCommand(checkPath: string, ctx: Context) {
  const draftPath = resolve(checkPath);
  const result = await validateWorktreeReviewDraft(draftPath, false, ctx);
  if (result.issues.length > 0 || !result.ready) {
    ctx.stderr(formatRejection(draftPath, result.issues, WORKTREE_APPLY_COMMAND));
    return 1;
  }
  ctx.stdout("PAIRE_DRAFT_OK");
  return 0;
}

async function validateWorktreeReviewDraft(
  draftPath: string,
  useStdin: boolean,
  ctx: Context,
): Promise<{ ready?: ReadyWorktreeApply; issues: ApplyIssue[] }> {
  const raw = useStdin
    ? await new Response(Bun.stdin).text()
    : await Bun.file(draftPath).text();
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
  const worktreeReviewId = readStringProperty(stripped, "worktreeReviewId");
  const review =
    session && worktreeReviewId
      ? getWorktreeReviewById(ctx.db, worktreeReviewId)
      : null;
  // Prior claims come from this hash's payload when re-applying, otherwise from
  // the most recent applied worktree review so a draft amended across a diff
  // change still validates and hydrates unchanged claims.
  const priorPayload =
    review && session && review.sessionId === session.id
      ? parseWorktreePayload(
          review.state === "applied" && review.payloadJson
            ? review.payloadJson
            : (getLatestAppliedWorktreeReview(ctx.db, session.id)?.payloadJson ??
                null),
        )
      : null;
  const priorActiveClaims = priorPayload
    ? worktreeActiveClaims(priorPayload)
    : [];
  const knownClaimIds = new Set(priorActiveClaims.map((claim) => claim.id));
  const validation = validateWorktreeApplyPayload(stripped, { knownClaimIds });
  const issues = [...validation.issues];
  const payload = validation.payload;

  if (!payload) return { issues };
  if (!session) {
    issues.push({
      code: "unknown_revision",
      field: "sessionId",
      value: payload.sessionId,
      fix: "Run paire it again on the dirty worktree and edit the generated worktree-review-draft.json.",
    });
    return { issues };
  }

  const git = getGitState(session.repoRoot);
  const worktree = gitWorktreeDiff(session.repoRoot);
  const currentHash = computeWorktreeHash(git, worktree);
  if (currentHash !== payload.worktreeHash) {
    issues.push({
      code: "stale_worktree",
      field: "worktreeHash",
      value: payload.worktreeHash,
      fix: `The working tree changed since this draft was generated. Run paire it again; the current worktree hash is ${currentHash}.`,
    });
  }
  if (git.head !== payload.gitHead) {
    issues.push({
      code: "stale_worktree",
      field: "gitHead",
      value: payload.gitHead,
      fix: `HEAD moved since this draft was generated. Run paire it again; current HEAD is ${git.head}.`,
    });
  }

  if (
    !review ||
    review.sessionId !== session.id ||
    review.worktreeHash !== payload.worktreeHash
  ) {
    issues.push({
      code: "unknown_worktree_review",
      field: "worktreeReviewId",
      value: payload.worktreeReviewId,
      fix: "Run paire it again on the dirty worktree and edit the current worktree-review-draft.json.",
    });
    return { issues };
  }

  const packet = parseStoredWorktreePacket(review);
  if (!packet || packet.packetId !== payload.packetId) {
    issues.push({
      code: "unknown_worktree_review",
      field: "packetId",
      value: payload.packetId,
      fix: "Run paire it again; this draft does not match the current worktree packet.",
    });
    return { issues };
  }

  issues.push(
    ...checkPriorClaims(
      priorActiveClaims.flatMap((claim) =>
        claim.threadId ? [{ id: claim.id, threadId: claim.threadId }] : [],
      ),
      payload,
      validation.submittedClaimIds,
    ),
    ...checkCoverage(
      packet,
      payload,
      worktreePreservedEvidencePaths(priorPayload, payload),
    ),
  );

  if (issues.length > 0) return { issues };
  return { ready: { payload, session, git, review, packet, priorPayload }, issues };
}

function worktreePreservedEvidencePaths(
  priorPayload: AgentWorktreeApplyPayload | null,
  payload: AgentWorktreeApplyPayload,
) {
  if (!priorPayload) return [];
  const priorEvidencePaths = new Map<string, string[]>();
  for (const thread of priorPayload.threads) {
    for (const claim of thread.claims) {
      priorEvidencePaths.set(
        claim.id,
        (claim.evidences ?? []).map((evidence) => evidence.filePath),
      );
    }
  }
  const paths: string[] = [];
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      if (
        claim.agentStatus !== "unchanged" ||
        (claim.evidences && claim.evidences.length > 0)
      ) {
        continue;
      }
      for (const path of priorEvidencePaths.get(claim.id) ?? []) {
        paths.push(path);
      }
    }
  }
  return paths;
}

// Merge a freshly-validated worktree apply payload with the prior applied
// payload so unchanged/minimal claims keep their stored copy, importance,
// evidences, and human status. Mirrors the committed apply preserve logic but
// operates on the JSON payload instead of normalized tables.
function mergeWorktreePayload(
  prior: AgentWorktreeApplyPayload | null,
  next: AgentWorktreeApplyPayload,
): AgentWorktreeApplyPayload {
  const priorThreads = new Map<string, AgentThread>();
  const priorClaims = new Map<string, AgentClaim>();
  if (prior) {
    for (const thread of prior.threads) {
      priorThreads.set(thread.id, thread);
      for (const claim of thread.claims) priorClaims.set(claim.id, claim);
    }
  }

  const threads = next.threads.map((thread) => {
    const priorThread = priorThreads.get(thread.id);
    const preserveThreadCopy =
      !!priorThread &&
      thread.claims.length > 0 &&
      thread.claims.every((claim) => canPreserveExistingThreadCopy(claim));
    const claims = thread.claims.map((claim) =>
      mergeWorktreeClaim(claim, thread.id, priorClaims.get(claim.id)),
    );
    const title = preserveThreadCopy && priorThread ? priorThread.title : thread.title;
    const summary =
      preserveThreadCopy && priorThread ? priorThread.summary : thread.summary;
    return {
      id: thread.id,
      title,
      ...(summary ? { summary } : {}),
      claims,
    } satisfies AgentThread;
  });
  return { ...next, threads };
}

function mergeWorktreeClaim(
  claim: AgentClaim,
  parentThreadId: string,
  prior: AgentClaim | undefined,
): AgentClaim {
  const threadId = claim.threadId ?? parentThreadId;
  const hydrate = !!prior && !claim.title;
  const title = hydrate ? (prior?.title ?? "") : (claim.title ?? "");
  const description = hydrate
    ? prior?.description
    : claim.description;
  const importance = hydrate
    ? (prior?.importance ?? "minor")
    : (claim.importance ?? "minor");
  const before = hydrate
    ? (prior?.before ?? null)
    : (claim.before ?? null);
  const after = hydrate
    ? (prior?.after ?? null)
    : (claim.after ?? null);
  const preserveEvidence =
    canPreserveExistingEvidenceRows(claim.agentStatus) &&
    (!claim.evidences || claim.evidences.length === 0);
  const evidences = preserveEvidence
    ? (prior?.evidences ?? [])
    : (claim.evidences ?? []);
  const humanStatus =
    prior && claim.agentStatus !== "unchanged"
      ? "unreviewed"
      : (prior?.humanStatus ?? claim.humanStatus ?? "unreviewed");
  return {
    id: claim.id,
    threadId,
    title,
    ...(description ? { description } : {}),
    agentStatus: claim.agentStatus,
    importance,
    humanStatus,
    before,
    after,
    evidences,
  };
}

function worktreeActiveClaims(
  payload: AgentWorktreeApplyPayload,
): Array<AgentClaim & { threadId: string; threadTitle: string }> {
  const claims: Array<AgentClaim & { threadId: string; threadTitle: string }> = [];
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      if (
        claim.agentStatus === "invalidated" ||
        claim.agentStatus === "superseded"
      ) {
        continue;
      }
      claims.push({
        ...claim,
        threadId: claim.threadId ?? thread.id,
        threadTitle: thread.title,
      });
    }
  }
  return claims;
}

async function createWorktreeReviewDraft(
  ctx: Context,
  session: SessionRow,
  git: GitState,
) {
  const worktree = gitWorktreeDiff(session.repoRoot);
  const worktreeHash = computeWorktreeHash(git, worktree);
  const existing = getWorktreeReviewByHash(ctx.db, session.id, worktreeHash);
  const worktreeReviewId = existing?.id ?? `wtr_${crypto.randomUUID()}`;
  const packetId = `wpkt_${worktreeReviewId}`;
  const changedFiles = summarizeChangedFiles(worktree.diff);
  const safeInspectionCommands = changedFiles
    .filter((file) => file.summarized)
    .flatMap((file) => [
      `git diff --stat -- ${shellQuote(file.path)}`,
      `git diff --unified=40 -- ${shellQuote(file.path)}`,
    ]);
  // Seed the draft with the prior claims so the agent amends them like the
  // committed flow: reuse this hash's payload if it was already applied,
  // otherwise carry forward the most recent applied worktree review.
  const priorPayload = parseWorktreePayload(
    existing?.payloadJson ??
      getLatestAppliedWorktreeReview(ctx.db, session.id)?.payloadJson ??
      null,
  );
  const activeClaims = priorPayload ? worktreeActiveClaims(priorPayload) : [];
  const packet: WorktreePacket = {
    packetId,
    sessionId: session.id,
    projectKey: session.projectKey,
    worktreeReviewId,
    worktreeHash,
    gitHead: git.head,
    goal: session.goal,
    changedFiles,
    skipped: worktree.skipped,
    touchedSnippets: touchedSnippets(worktree.diff),
    activeClaims,
    safeInspectionCommands,
  };
  const packetJson = JSON.stringify(packet, null, 2);
  const packetPath = await writeWorktreePacketExport(ctx, session, packetJson);
  const draftPacket: WorktreeDraftPacket = {
    packetId,
    sessionId: session.id,
    worktreeReviewId,
    worktreeHash,
    gitHead: git.head,
    goal: session.goal,
    changedFiles,
    skipped: worktree.skipped,
    touchedSnippets: packet.touchedSnippets,
    safeInspectionCommands,
  };
  const draft = buildWorktreeReviewDraft(draftPacket, activeClaims);
  const draftJson = JSON.stringify(draft, null, 2);
  const draftPath = await writeWorktreeDraftExport(ctx, session, draftJson);
  const now = Date.now();
  if (existing) {
    ctx.db
      .prepare(
        "update worktree_reviews set gitHead = ?, packetJson = ?, draftPath = ?, updatedAt = ? where id = ?",
      )
      .run(git.head, packetJson, draftPath, now, worktreeReviewId);
  } else {
    ctx.db
      .prepare(
        `insert into worktree_reviews (id, sessionId, worktreeHash, gitHead, state, packetJson, draftPath, payloadJson, createdAt, updatedAt, appliedAt)
         values (?, ?, ?, ?, 'pending_agent', ?, ?, null, ?, ?, null)`,
      )
      .run(
        worktreeReviewId,
        session.id,
        worktreeHash,
        git.head,
        packetJson,
        draftPath,
        now,
        now,
      );
  }
  return {
    path: packetPath,
    draftPath,
    worktreeHash,
    changedFiles,
    skipped: worktree.skipped,
    applied: existing?.state === "applied",
    preview: worktreeDraftPreview(packet, draftPath),
  };
}

function computeWorktreeHash(
  git: GitState,
  worktree: { diff: string; skipped: string[] },
) {
  return new Bun.CryptoHasher("sha256")
    .update(PAIRE_VERSION)
    .update("\0")
    .update(git.head)
    .update("\0")
    .update(git.status)
    .update("\0")
    .update(worktree.diff)
    .update("\0")
    .update(worktree.skipped.join("\n"))
    .digest("hex");
}

function worktreeDraftPreview(packet: WorktreePacket, draftPath: string) {
  return [
    `Worktree draft: ${draftPath}`,
    `Packet: ${packet.packetId}`,
    `Worktree hash: ${packet.worktreeHash}`,
    `HEAD: ${packet.gitHead}`,
    `Changed files: ${packet.changedFiles.length}`,
    ...packet.changedFiles
      .slice(0, 12)
      .map((file) => `- ${file.path} (+${file.additions}/-${file.deletions})`),
    ...(packet.changedFiles.length > 12
      ? [`- ... ${packet.changedFiles.length - 12} more`]
      : []),
  ].join("\n");
}

function worktreeActionRequiredMessage({
  git,
  draft,
}: {
  git: GitState;
  draft: {
    draftPath: string;
    preview: string;
    applied: boolean;
  };
}) {
  return [
    "PAIRE_WORKTREE_REVIEW",
    "ACTION REQUIRED — update the Paire worktree review",
    "",
    "These are uncommitted working-tree changes. Paire reviews them separately from",
    "committed claims and keys the result to the current worktree diff.",
    "A working-tree preview was opened for the human at the URL below.",
    "",
    draft.applied
      ? "A worktree review was already applied for this exact diff; re-applying updates it."
      : "No worktree review has been applied for this diff yet.",
    "",
    "Three steps. Done when step 3 exits 0.",
    "",
    "Step 1 — Inspect the worktree diff",
    "Run and read:",
    "git diff -w HEAD",
    "(plus any untracked files Paire previewed)",
    "",
    "Step 2 — Edit the worktree review draft IN PLACE (do not create a new file)",
    draft.draftPath,
    "The draft is pre-filled: header IDs, every changed file under \"files\", and all prior",
    "worktree claims (agentStatus \"unchanged\") are already correct.",
    "- Cover every \"files\" entry: reference it from a claim's evidences, or set its",
    "  disposition to \"acknowledged\" with a reason (mechanical/generated churn only).",
    "- Leave still-accurate prior claims exactly as listed. Never delete a prior claim.",
    "- Add new claims following context.claimTemplate; copy line numbers from the N|",
    "  prefixes in context.touchedSnippets. Follow the \"instructions\" in the draft.",
    "",
    "Step 3 — Apply",
    `${WORKTREE_APPLY_COMMAND} ${draft.draftPath}`,
    "On failure it prints PAIRE_APPLY_REJECTED with a JSON list of exact fixes — edit the",
    "draft and re-run. On success the Review UI opens automatically.",
    draft.preview,
    "",
    `Current branch: ${git.branch}`,
    `Current HEAD: ${git.head}`,
  ].join("\n");
}

function formatWorktreeStatus(
  session: SessionRow,
  git: GitState,
  payload: AgentWorktreeApplyPayload,
) {
  return [
    "Paire worktree review applied",
    `Session: ${session.id}`,
    `Branch: ${git.branch}`,
    `Worktree hash: ${payload.worktreeHash}`,
    `HEAD: ${payload.gitHead}`,
    `Review burden: ${worktreeBurden(payload)}`,
  ].join("\n");
}

function worktreeBurden(payload: AgentWorktreeApplyPayload) {
  const counts = new Map<string, number>();
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      counts.set(claim.agentStatus, (counts.get(claim.agentStatus) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "0 claims";
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
}

function parseWorktreePayload(
  payloadJson: string | null,
): AgentWorktreeApplyPayload | null {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson) as AgentWorktreeApplyPayload;
  } catch {
    return null;
  }
}

function parseStoredWorktreePacket(review: WorktreeReviewRow) {
  if (!review.packetJson) return null;
  return JSON.parse(review.packetJson) as WorktreePacket;
}

function getWorktreeReviewByHash(
  db: Database,
  sessionId: string,
  worktreeHash: string,
) {
  return db
    .query<WorktreeReviewRow, [string, string]>(
      "select * from worktree_reviews where sessionId = ? and worktreeHash = ?",
    )
    .get(sessionId, worktreeHash);
}

function getWorktreeReviewById(db: Database, id: string) {
  return db
    .query<WorktreeReviewRow, [string]>(
      "select * from worktree_reviews where id = ?",
    )
    .get(id);
}

// The most recently applied worktree review for a session, regardless of hash.
// Used to seed/amend drafts and to keep showing prior claims when the worktree
// diff has moved on (the claims are then surfaced as stale).
function getLatestAppliedWorktreeReview(db: Database, sessionId: string) {
  return db
    .query<WorktreeReviewRow, [string]>(
      "select * from worktree_reviews where sessionId = ? and state = 'applied' order by appliedAt desc, updatedAt desc limit 1",
    )
    .get(sessionId);
}

async function writeWorktreePacketExport(
  ctx: Context,
  session: SessionRow,
  packetJson: string,
) {
  const directory = projectExportDirectory(ctx, session);
  ensurePrivateDirectory(directory);
  const path = join(directory, "worktree-packet.json");
  await Bun.write(path, packetJson);
  ensurePrivateFile(path);
  return path;
}

async function writeWorktreeDraftExport(
  ctx: Context,
  session: SessionRow,
  draftJson: string,
) {
  const directory = projectExportDirectory(ctx, session);
  ensurePrivateDirectory(directory);
  const path = join(directory, "worktree-review-draft.json");
  await Bun.write(path, draftJson);
  ensurePrivateFile(path);
  return path;
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
    ...checkEvidenceSpans(packet, payload),
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
      await serverStopCommand(rest, ctx);
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
  if (parsed.flags.has("open")) {
    await ctx.openBrowser(state.url);
  }
  ctx.stdout(reviewUiMessage(state.url));
}

async function serverStopCommand(args: string[], ctx: Context) {
  const parsed = parseFlags(args);

  if (parsed.flags.has("all")) {
    const outcome = await stopReviewDaemonCompletely(ctx);
    if (outcome === "stopped") {
      ctx.stdout("Stopped the shared review server.");
    } else if (outcome === "stale") {
      ctx.stdout("Review server was not running. Removed stale state.");
    } else {
      ctx.stdout("No review server is running.");
    }
    return;
  }

  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  if (!session) {
    ctx.stdout(
      `No Paire session found for branch ${git.branch}.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`,
    );
    return;
  }

  const result = await stopReviewSession(ctx, session);
  if (result.outcome === "stopped") {
    if (result.daemonStopped) {
      ctx.stdout("Stopped the review UI server.");
    } else {
      const others =
        result.remaining === 1 ? "1 other branch" : `${result.remaining} other branches`;
      ctx.stdout(
        `Stopped the review UI for ${git.branch}. The shared review server is still running for ${others} (paire server stop --all to stop it).`,
      );
    }
    return;
  }
  if (result.outcome === "stale") {
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
        .prepare("delete from worktree_reviews where sessionId = ?")
        .run(sessionId);
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
  const annotatedDiffPath = await writeAnnotatedDiffExport(
    ctx,
    session,
    buildAnnotatedDiff(incrementalDiff),
  );
  const changedFiles = summarizeChangedFiles(incrementalDiff);
  const safeInspectionCommands = changedFiles
    .filter((file) => file.summarized)
    .flatMap((file) => [
      `git diff --stat -- ${shellQuote(file.path)}`,
      `git diff --unified=40 -- ${shellQuote(file.path)}`,
    ]);
  // Double-check evidence line numbers against the real file: nl -ba numbers the
  // post-change file with the same coordinate system evidence spans use.
  safeInspectionCommands.push(
    ...changedFiles
      .filter((file) => file.additions > 0)
      .slice(0, 20)
      .map((file) => `nl -ba -- ${shellQuote(file.path)}`),
  );
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
    annotatedDiffPath,
    touchedSnippets: touchedSnippets(incrementalDiff),
    touchedRanges: touchedRanges(incrementalDiff),
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
      "Evidence startLine/endLine are 1-based line numbers in the post-change file (HEAD). Copy them from the N| prefixes in the annotated diff at annotatedDiffPath (also mirrored in touchedSnippets.text); -N| marks a removed line by its old number — never copy a -N.",
      "Double-check a span by running nl -ba on the file (in safeInspectionCommands): it numbers the post-change file with the same coordinate system evidence uses.",
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
    annotatedDiffPath: packet.annotatedDiffPath,
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
    "worktree-packet.json",
    "worktree-review-draft.json",
    "annotated-diff.txt",
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

async function writeAnnotatedDiffExport(
  ctx: Context,
  session: SessionRow,
  annotatedDiff: string,
) {
  const directory = projectExportDirectory(ctx, session);
  ensurePrivateDirectory(directory);
  const path = join(directory, "annotated-diff.txt");
  await Bun.write(path, annotatedDiff);
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
      : "Worktree review available: run paire it to create or update the worktree review draft.",
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

function reviewActionRequiredMessage({
  diffFromLabel,
  lastAppliedId,
  packet,
}: {
  diffFromLabel: string;
  lastAppliedId: string | null;
  packet: {
    path: string;
    draftPath: string;
    annotatedDiffPath: string;
    preview: string;
  };
}) {
  return [
    "ACTION REQUIRED — update the Paire review",
    "",
    "Three steps. Done when step 3 exits 0.",
    "",
    "Step 1 — Read the annotated diff",
    "Read this file:",
    packet.annotatedDiffPath,
    `(diff range: ${diffFromLabel})`,
    "Format legend: `N|+ added` and `N|  context` carry the post-change line number N —",
    "copy N into evidence startLine/endLine. `-N|- removed` shows the old line number;",
    "never copy a -N.",
    lastAppliedId ? `Last applied Paire revision: ${lastAppliedId}` : "Last applied Paire revision: none",
    "",
    "Step 2 — Edit the review draft IN PLACE (do not create a new file)",
    packet.draftPath,
    "The draft is pre-filled: header IDs, every changed file under \"files\", and all prior",
    "claims (agentStatus \"unchanged\") are already correct.",
    "- Cover every \"files\" entry: reference it from a claim's evidences, or set its",
    "  disposition to \"acknowledged\" with a reason (mechanical/generated churn only).",
    "- Leave still-accurate prior claims exactly as listed. Never delete a prior claim.",
    `- Add new claims following context.claimTemplate; copy line numbers from the N|`,
    `  prefixes in the annotated diff at ${packet.annotatedDiffPath}; never copy a -N|`,
    "  (removed line) number. Follow the \"instructions\" in the draft.",
    "",
    "Step 3 — Apply",
    `paire review --apply ${packet.draftPath}`,
    "On failure it prints PAIRE_APPLY_REJECTED with a JSON list of exact fixes — edit the",
    "draft and re-run. On success the Review UI opens automatically.",
    packet.preview,
    "",
  ].join("\n");
}


async function printStatusAndOpen(
  session: SessionRow,
  git: GitState,
  ctx: Context,
  open: boolean,
) {
  ctx.stdout(formatStatus(ctx.db, session, git));
  await openReviewUi(ctx, session, git, open);
}

function paireCliSpawnArgs(...args: string[]): string[] {
  if (import.meta.path.startsWith("/$bunfs/")) {
    return [process.execPath, ...args];
  }
  return [process.execPath, join(import.meta.dir, "../cli.ts"), ...args];
}

async function openReviewUi(
  ctx: Context,
  session: SessionRow,
  _git: GitState,
  open: boolean,
) {
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
    if (open) await ctx.openBrowser(url);
    ctx.stdout(reviewUiMessage(url));
    server.stop();
    return;
  }

  const state = await ensureReviewServer(ctx, session);
  if (open) await ctx.openBrowser(state.url);
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
// Unregister a single branch's review from the shared daemon.
//   outcome "stopped" = handed off to a live daemon; "stale" = no live daemon,
//   cleaned up the leftover file; "missing" = nothing registered for this branch.
//   daemonStopped = this was the last branch, so the shared server is exiting.
//   remaining = branches still served by the daemon afterwards.
type StopSessionResult = {
  outcome: "stopped" | "stale" | "missing";
  daemonStopped: boolean;
  remaining: number;
};

async function stopReviewSession(
  ctx: Context,
  session: SessionRow,
): Promise<StopSessionResult> {
  const statePath = reviewServerStatePath(ctx, session.id);
  if (!existsSync(statePath)) {
    return { outcome: "missing", daemonStopped: false, remaining: 0 };
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
    let daemonStopped = false;
    let remaining = 0;
    try {
      const response = await fetch(
        new URL("/api/_internal/unregister", daemon.baseUrl),
        {
          method: "POST",
          headers: {
            [REVIEW_TOKEN_HEADER]: daemon.adminToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId: session.id }),
          signal: AbortSignal.timeout(2_000),
        },
      );
      const data = (await response.json()) as {
        empty?: unknown;
        remaining?: unknown;
      };
      daemonStopped = data.empty === true;
      remaining = typeof data.remaining === "number" ? data.remaining : 0;
    } catch {
      // daemon may have exited between checks; the file is already gone
    }
    return { outcome: "stopped", daemonStopped, remaining };
  }

  return { outcome: "stale", daemonStopped: false, remaining: 0 };
}

// Stop the whole shared daemon and clear every branch's review state.
//   "stopped" = a live daemon was shut down; "stale" = state file but no live
//   daemon, cleaned up; "missing" = no daemon state at all.
async function stopReviewDaemonCompletely(
  ctx: Context,
): Promise<"stopped" | "stale" | "missing"> {
  const daemon = readReviewDaemonState(reviewDaemonStatePath(ctx));
  const daemonAlive =
    !!daemon &&
    isProcessRunning(daemon.pid) &&
    (await isReviewDaemonAlive(daemon));

  if (daemon && daemonAlive) {
    await shutdownReviewDaemon(daemon);
  }
  clearReviewServerStateFiles(ctx);
  if (!daemon) return "missing";
  return daemonAlive ? "stopped" : "stale";
}

function clearReviewServerStateFiles(ctx: Context) {
  try {
    unlinkSync(reviewDaemonStatePath(ctx));
  } catch {
    // ignore
  }
  const dir = join(ctx.paireHome, "review-servers");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // ignore
    }
  }
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
    const remaining = sessionTokens.size;
    const empty = remaining === 0;
    if (empty) queueShutdown();
    return Response.json({ ok: true, empty, remaining });
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
    "/api/worktree/diff": sessionRoute(handleWorktreeDiffRequest),
    "/api/worktree/review": sessionRoute(handleWorktreeReviewRequest),
    "/api/worktree/claims/:claimId/human-status": sessionRoute(
      handleWorktreeHumanStatusRequest,
    ),
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

async function handleWorktreeDiffRequest(
  request: Request,
  session: SessionRow,
  _ctx: Context,
) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const git = getGitState(session.repoRoot);
  const worktree = gitWorktreeDiff(session.repoRoot);
  return Response.json({
    diff: worktree.diff,
    files: summarizeChangedFiles(worktree.diff).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    skipped: worktree.skipped,
    worktreeHash: computeWorktreeHash(git, worktree),
  });
}

async function handleWorktreeReviewRequest(
  request: Request,
  session: SessionRow,
  ctx: Context,
) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const git = getGitState(session.repoRoot);
  const worktree = gitWorktreeDiff(session.repoRoot);
  const worktreeHash = computeWorktreeHash(git, worktree);
  const review = getWorktreeReviewByHash(ctx.db, session.id, worktreeHash);
  const current =
    review?.state === "applied"
      ? parseWorktreePayload(review.payloadJson)
      : null;
  // When the current diff has no applied review, fall back to the most recent
  // applied worktree review so prior claims keep showing — flagged as stale so
  // the UI can prompt the agent to regenerate and amend them.
  const fallback = current
    ? null
    : getLatestAppliedWorktreeReview(ctx.db, session.id);
  const fallbackPayload = fallback
    ? parseWorktreePayload(fallback.payloadJson)
    : null;
  const payload = current ?? fallbackPayload;
  const stale = !current && !!payload;
  return Response.json({
    worktreeHash,
    state: review?.state ?? "none",
    stale,
    appliedHash: current ? worktreeHash : (fallback?.worktreeHash ?? null),
    draftPath: review?.draftPath ?? null,
    burden: payload ? worktreeBurden(payload) : "0 claims",
    generatedAt: Date.now(),
    threads: payload ? buildWorktreeReviewThreads(payload) : [],
  });
}

async function handleWorktreeHumanStatusRequest(
  request: Request,
  session: SessionRow,
  ctx: Context,
) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const claimId = (request as Request & { params: { claimId: string } }).params
    .claimId;
  const body = (await request.json()) as { humanStatus?: unknown };
  if (
    typeof body.humanStatus !== "string" ||
    !VALID_HUMAN_STATUSES.has(body.humanStatus)
  ) {
    return Response.json({ error: "Invalid humanStatus." }, { status: 400 });
  }
  const git = getGitState(session.repoRoot);
  const worktree = gitWorktreeDiff(session.repoRoot);
  const worktreeHash = computeWorktreeHash(git, worktree);
  const current = getWorktreeReviewByHash(ctx.db, session.id, worktreeHash);
  // Update whichever applied review owns the shown claims: this hash when it has
  // an applied review, otherwise the most recent applied (stale) review.
  const review =
    current?.state === "applied"
      ? current
      : getLatestAppliedWorktreeReview(ctx.db, session.id);
  const payload = review ? parseWorktreePayload(review.payloadJson) : null;
  if (!review || !payload) {
    return Response.json(
      { error: "No applied worktree review for this session." },
      { status: 404 },
    );
  }
  let found = false;
  for (const thread of payload.threads) {
    for (const claim of thread.claims) {
      if (claim.id === claimId) {
        claim.humanStatus = body.humanStatus as HumanStatus;
        found = true;
      }
    }
  }
  if (!found) {
    return Response.json({ error: "Claim not found." }, { status: 404 });
  }
  ctx.db
    .prepare(
      "update worktree_reviews set payloadJson = ?, updatedAt = ? where id = ?",
    )
    .run(JSON.stringify(payload), Date.now(), review.id);
  return Response.json({ ok: true });
}

// Format an applied worktree payload into the thread/claim shape the review UI
// renders, sorted by importance like committed review data.
function buildWorktreeReviewThreads(payload: AgentWorktreeApplyPayload) {
  return payload.threads
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      summary: thread.summary ?? "",
      claims: thread.claims
        .filter(
          (claim) =>
            claim.agentStatus !== "invalidated" &&
            claim.agentStatus !== "superseded",
        )
        .map((claim) => ({
          id: claim.id,
          title: claim.title ?? "",
          description: claim.description,
          before: claim.before ?? null,
          after: claim.after ?? null,
          agentStatus: claim.agentStatus,
          importance: (claim.importance ?? "minor") as ClaimImportance,
          humanStatus: (claim.humanStatus ?? "unreviewed") as HumanStatus,
          updatedAt: claim.updatedAt,
          evidences: (claim.evidences ?? []).map((evidence) => ({
            claimId: claim.id,
            filePath: evidence.filePath,
            startLine: evidence.startLine,
            endLine: evidence.endLine,
            symbol: evidence.symbol,
            change: evidence.change,
          })),
        }))
        .sort(compareClaimsByImportance),
    }))
    .filter((thread) => thread.claims.length > 0)
    .sort(compareThreadsByImportance);
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
    create table if not exists worktree_reviews (
      id text primary key,
      sessionId text not null,
      worktreeHash text not null,
      gitHead text not null,
      state text not null,
      packetJson text,
      draftPath text,
      payloadJson text,
      createdAt integer not null,
      updatedAt integer not null,
      appliedAt integer,
      unique(sessionId, worktreeHash)
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

function gitWorktreeDiff(repoRoot: string) {
  const trackedDiff = gitCommand(["diff", "-w", "HEAD"], repoRoot);
  const skipped: string[] = [];
  const parts = trackedDiff.trimEnd() ? [trackedDiff.trimEnd()] : [];
  const untrackedPaths = gitCommand(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repoRoot,
  )
    .split("\0")
    .filter(Boolean);

  for (const filePath of untrackedPaths) {
    try {
      const stat = statSync(join(repoRoot, filePath));
      if (!stat.isFile() || stat.size > MAX_WORKTREE_PREVIEW_FILE_BYTES) {
        skipped.push(filePath);
        continue;
      }
    } catch {
      skipped.push(filePath);
      continue;
    }

    const diff = gitCommand(
      ["diff", "--no-index", "--", "/dev/null", filePath],
      repoRoot,
      { allowFail: true },
    );
    if (!diff.trim()) continue;
    if (diff.includes("\0") || /^Binary files /m.test(diff)) {
      skipped.push(filePath);
      continue;
    }
    parts.push(diff.trimEnd());
  }

  return { diff: parts.join("\n"), skipped };
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

function buildAnnotatedDiff(diff: string): string {
  try {
    const patches = parsePatchFiles(diff, "paire-annotated", false);
    const sections: string[] = [];
    for (const file of patches.flatMap((patch) => patch.files)) {
      const raw = fileToRawDiff(diff, file.name);
      const summarize = shouldSummarizeFile(file.name, raw);
      sections.push(`=== ${file.name} ===`);
      if (summarize) {
        sections.push(
          `[summarized: ${file.name} is too large or generated; inspect the artifact diff path instead]`,
        );
        continue;
      }
      for (const hunk of file.hunks) {
        const rawHunk = rawHunkText(raw, hunk.hunkSpecs ?? "");
        const annotated = annotateHunkText(
          rawHunk,
          hunk.additionStart,
          hunk.deletionStart,
        );
        sections.push(annotated.annotatedText);
      }
    }
    if (sections.length === 0) return diff;
    return `${sections.join("\n")}\n`;
  } catch {
    return diff;
  }
}

function touchedRanges(diff: string): TouchedRange[] {
  try {
    const patches = parsePatchFiles(diff, "paire-ranges", false);
    const out: TouchedRange[] = [];
    for (const file of patches.flatMap((patch) => patch.files)) {
      const raw = fileToRawDiff(diff, file.name);
      if (shouldSummarizeFile(file.name, raw)) continue;
      const ranges: Array<{ startLine: number; endLine: number }> = [];
      for (const hunk of file.hunks) {
        if (hunk.additionCount > 0) {
          ranges.push({
            startLine: hunk.additionStart,
            endLine: hunk.additionStart + hunk.additionCount - 1,
          });
          continue;
        }
        // Pure-deletion hunk (no new-side lines): anchor a point range at the
        // deletion site so the +/-tolerance window keeps deletion-anchored
        // "new" claims valid instead of dropping coverage for this region.
        const anchor = Math.max(1, hunk.additionStart);
        ranges.push({ startLine: anchor, endLine: anchor });
      }
      if (ranges.length > 0) out.push({ filePath: file.name, ranges });
    }
    return out;
  } catch {
    return [];
  }
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
    if (name === "stdin" || name === "open" || name === "no-open" || name === "all") {
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
    "  review [--apply <file> | --check <file> | --stdin] [--open]",
    "  worktree [--apply <file> | --check <file> | --stdin] [--open]",
    "  it [--open]",
    "  status",
    "  sync",
    "  reset",
    "  server start [--open]",
    "  server stop [--all]",
    "  install",
    "  upgrade [--force]",
    "  version",
  ].join("\n");
}

function serverHelpText() {
  return [
    "Usage: paire server <command>",
    "",
    "Commands:",
    "  start [--open]      Start or reuse the shared review server for the current branch (--open launches a browser)",
    "  stop                Stop the review UI for the current branch (stops the shared server if it was the last)",
    "  stop --all          Stop the shared review server for every branch",
  ].join("\n");
}
