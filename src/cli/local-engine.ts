import { parsePatchFiles } from "@pierre/diffs";
import { Database } from "bun:sqlite";

import { addedLineRanges, annotateHunkText } from "./diff-line-numbers";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

type ClaimStatus =
  | "new"
  | "unchanged"
  | "evidence_moved"
  | "amended"
  | "invalidated"
  | "superseded";

type HumanStatus = "unreviewed" | "accepted";

type AgentEvidence = {
  claimId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  fingerprint?: string;
  revisionId?: string;
  change: string;
};

type AgentClaim = {
  id: string;
  threadId: string;
  title: string;
  description?: string;
  before?: string | null;
  after?: string | null;
  agentStatus: ClaimStatus;
  humanStatus?: HumanStatus;
  updatedAt?: number;
  evidences: AgentEvidence[];
};

type AgentThread = {
  id: string;
  title: string;
  summary?: string;
  claims: AgentClaim[];
};

type AgentApplyPayload = {
  packetId: string;
  sessionId: string;
  revisionId: string;
  gitFingerprint: string;
  threads: AgentThread[];
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

const LARGE_DIFF_BYTES = 30_000;
const MAX_INLINE_SNIPPET_CHARS = 4_000;
const MAX_TOTAL_SNIPPET_CHARS = 18_000;
const MAX_PACKET_PREVIEW_CHARS = 16_000;
const MAX_APPLY_PAYLOAD_BYTES = 2_000_000;
const MAX_THREADS_PER_APPLY = 100;
const MAX_CLAIMS_PER_THREAD = 200;
const MAX_EVIDENCES_PER_CLAIM = 50;
const MAX_ID_CHARS = 160;
const MAX_TITLE_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_BEHAVIOR_COPY_CHARS = 4_000;
const MAX_EVIDENCE_CHANGE_CHARS = 1_000;
const MAX_COMMENT_CHARS = 4_000;
const MAX_FILE_PATH_CHARS = 1_000;
const MAX_EVIDENCE_LINE = 1_000_000;
const MAX_EVIDENCE_SPAN_LINES = 5_000;
const REVIEW_PORT = 0;
const REVIEW_SERVER_START_TIMEOUT_MS = 5_000;
const REVIEW_TOKEN_BYTES = 32;
const REVIEW_TOKEN_HEADER = "x-paire-review-token";

type ReviewServerState = {
  pid: number;
  port: number;
  url: string;
  token: string;
  sessionId: string;
  repoRoot: string;
  startedAt: number;
};
const VALID_AGENT_STATUSES = new Set([
  "new",
  "unchanged",
  "evidence_moved",
  "amended",
  "invalidated",
  "superseded",
]);
const VALID_HUMAN_STATUSES = new Set(["unreviewed", "accepted"]);

export async function runCli(argv: string[], options: CliOptions = {}) {
  const ctx = makeContext(options);
  const [command = "help", ...rest] = argv;
  try {
    switch (command) {
      case "start":
        await startCommand(rest, ctx);
        return 0;
      case "review":
        await reviewCommand(rest, ctx);
        return 0;
      case "it":
        await itCommand(rest, ctx);
        return 0;
      case "reset":
        await resetCommand(ctx);
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
      case "_review-serve": {
        const sessionId = rest[0];
        if (!sessionId) throw new Error("Missing session id.");
        await reviewServeCommand(sessionId, ctx);
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
    insertAppliedBaselineRevision(ctx.db, sessionId, git.head, now);
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

async function reviewCommand(args: string[], ctx: Context) {
  const parsed = parseFlags(args);
  const applyPath = stringFlag(parsed, "apply");
  if (applyPath || parsed.flags.has("stdin")) {
    await applyReviewCommand(
      applyPath,
      parsed.flags.has("stdin"),
      parsed.flags.has("no-open"),
      ctx,
    );
    return;
  }

  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot, git.branch);
  if (!session) {
    const base = detectBaseRef(git.repoRoot);
    ctx.stdout(`No Paire session found.\nRun:\npaire start --base ${base}`);
    return;
  }
  if (!git.clean) {
    ctx.stdout(dirtyWorktreeMessage(git));
    await openReviewUi(ctx, session, git);
    return;
  }
  const lastApplied = getLastAppliedRevision(ctx.db, session.id);
  if (lastApplied?.gitFingerprint === git.fingerprint) {
    await printStatusAndOpen(session, git, ctx);
    return;
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
  const raw = useStdin
    ? await new Response(Bun.stdin).text()
    : await Bun.file(
        resolveRequiredPath(applyPath, "Missing --apply file."),
      ).text();
  if (raw.length > MAX_APPLY_PAYLOAD_BYTES) {
    throw new Error("Agent result is too large.");
  }
  const payload = validateApplyPayload(JSON.parse(raw));
  const session = ctx.db
    .query<SessionRow, [string]>("select * from sessions where id = ?")
    .get(payload.sessionId);
  if (!session) throw new Error("Session not found for apply payload.");
  const git = getGitState(session.repoRoot);
  if (!git.clean) {
    throw new Error(
      "Paire reviews committed code only. Commit the current worktree changes, then run paire review --apply again.",
    );
  }
  if (git.fingerprint !== payload.gitFingerprint) {
    throw new Error(
      `Stale Paire review update. Packet fingerprint ${payload.gitFingerprint} does not match current fingerprint ${git.fingerprint}. Run paire review again.`,
    );
  }
  const revision = ctx.db
    .query<RevisionRow, [string]>("select * from revisions where id = ?")
    .get(payload.revisionId);
  if (!revision || revision.state !== "pending_agent") {
    throw new Error("Pending revision not found for apply payload.");
  }
  if (revision.gitFingerprint !== payload.gitFingerprint) {
    throw new Error(
      "Apply payload does not match the pending revision fingerprint.",
    );
  }
  const packet = parseStoredPacket(revision);
  if (!packet || packet.packetId !== payload.packetId) {
    throw new Error("Apply payload does not match the canonical pending packet.");
  }

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
        thread.claims.every((claim) =>
          claim.agentStatus === "unchanged" ||
          claim.agentStatus === "evidence_moved"
        );
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
        const existingClaim = ctx.db
          .query<
            {
              title: string;
              description: string;
              beforeText: string | null;
              afterText: string | null;
              humanStatus: HumanStatus;
              updatedAt: number;
            },
            [string, string]
          >(
            "select title, description, beforeText, afterText, humanStatus, updatedAt from claims where id = ? and sessionId = ?",
          )
          .get(claimDbId, session.id);
        const claimCopy = normalizeClaimCopy(claim);
        const preserveClaimCopy =
          !!existingClaim && claim.agentStatus === "unchanged";
        const claimTitle = preserveClaimCopy
          ? existingClaim.title
          : claimCopy.title;
        const claimDescription = preserveClaimCopy
          ? existingClaim.description
          : claimCopy.description;
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
            `insert into claims (id, threadId, sessionId, title, description, beforeText, afterText, agentStatus, humanStatus, updatedAt)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set threadId = excluded.threadId, title = excluded.title,
               description = excluded.description,
               beforeText = excluded.beforeText, afterText = excluded.afterText,
               agentStatus = excluded.agentStatus, humanStatus = excluded.humanStatus, updatedAt = excluded.updatedAt`,
          )
          .run(
            claimDbId,
            threadDbId,
            session.id,
            claimTitle,
            claimDescription,
            claimBefore,
            claimAfter,
            claim.agentStatus,
            claimHumanStatus,
            preserveClaimCopy && existingClaim
              ? existingClaim.updatedAt
              : ++applyOrder,
          );
        ctx.db
          .prepare("delete from claim_evidences where claimId = ?")
          .run(claimDbId);
        for (const evidence of claim.evidences) {
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
        "Array<{ id, title, summary?, claims: Array<{ id, threadId, title, description?, before?, after?, agentStatus, humanStatus?, evidences: Array<{ filePath, startLine, endLine, symbol?, fingerprint?, change }> }> }>",
    },
    rules: [
      "Group related claims into area threads. Treat each thread as one review area with a short area title, not as a single diff line or file.",
      "Order areas and claims for review, not alphabetically: start with the main behavior or core contract, then supporting helpers, then consumers/usages, then tests, generated files, config, and lockfiles.",
      "Use the first area for the most important files or behavior a reviewer needs to understand before the rest of the change makes sense.",
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
      "On each claim, set optional before and after to high-level behavior summaries for the whole claim; use null when not applicable (pure addition: null before; pure removal: null after). Do not mention file paths or line numbers.",
      "On each evidence span, set change to a required imperative line describing what this span does; verb-first, concise, and may name symbols or APIs.",
    ],
  };
  const packetJson = JSON.stringify(packet, null, 2);
  const packetPath = await writeCurrentPacketExport(ctx, session, packetJson);
  const resultPath = join(dirname(packetPath), "agent-result.json");
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
        resultPath,
        totalDiffArtifactId,
        Date.now(),
      );
  } else {
    ctx.db
      .prepare(
        "update revisions set packetJson = ?, packetExportPath = ?, resultPath = ?, totalDiffArtifactId = ? where id = ?",
      )
      .run(packetJson, packetPath, resultPath, totalDiffArtifactId, revisionId);
  }
  return { path: packetPath, resultPath, preview: packetPreview(packetJson) };
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
  for (const filename of ["agent-result.json", "current-packet.json"]) {
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

function packetPreview(packetJson: string) {
  if (packetJson.length <= MAX_PACKET_PREVIEW_CHARS) return packetJson;
  const truncated = packetJson.slice(0, MAX_PACKET_PREVIEW_CHARS);
  return [
    truncated,
    "",
    `... truncated packet preview at ${MAX_PACKET_PREVIEW_CHARS} characters. Read the exported packet path above for the complete current packet.`,
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
      "Current pending packet export:",
      pending.packetExportPath ?? "(not exported)",
      "",
      "Packet preview:",
      packetPreview(pending.packetJson),
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
  packet: { path: string; resultPath: string; preview: string };
}) {
  return [
    "Action required",
    "",
    "Coding agent workflow — complete every step below in order.",
    "Do not skip steps. Do not stop after step 1 or 2. The task is incomplete until step 5 succeeds.",
    "",
    "Step 1 — Inspect the git diff (required)",
    `Changes since the last applied revision (${lastAppliedId ?? "none"}). Run and read the full output:`,
    `git diff ${diffFrom}..HEAD`,
    `(${diffFromLabel})`,
    "",
    "Step 2 — Read the full packet (required)",
    "Analyze this packet:",
    "Read the entire exported packet JSON at this path (use the preview below only as a shortcut):",
    packet.path,
    "",
    "Step 3 — Write the review update JSON (required)",
    "Write the review update JSON to:",
    packet.resultPath,
    "Follow packet.rules and resultSchema exactly.",
    "",
    "Step 4 — Apply the review (required)",
    "Then run:",
    `paire review --apply ${packet.resultPath}`,
    "Do not consider the review done until this command exits 0.",
    "",
    "Step 5 — Open the Review UI (required)",
    "After any `paire review` command prints a Review UI URL, open that URL in the browser.",
    "",
    "Before you stop, confirm every item:",
    "[ ] git diff inspected",
    "[ ] full packet read from the exported path",
    `[ ] JSON written to ${packet.resultPath}`,
    "[ ] paire review --apply succeeded",
    "[ ] Review UI opened when a URL was printed",
    "",
    "Packet preview:",
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
    "When paire review prints Action required, complete all five steps through paire review --apply.",
    "Do not stop until apply succeeds and you opened the Review UI URL when printed.",
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
    const server = createReviewServer(session, ctx, token);
    const url = reviewUiUrl(server.port, token);
    await ctx.openBrowser(url);
    ctx.stdout(reviewUiMessage(url));
    server.stop();
    return;
  }

  const statePath = reviewServerStatePath(ctx, session.id);
  const existing = readReviewServerState(statePath);
  if (existing?.pid && existing.token && isProcessRunning(existing.pid)) {
    await ctx.openBrowser(existing.url);
    ctx.stdout(reviewUiMessage(existing.url));
    return;
  }

  if (existing) {
    unlinkSync(statePath);
  }

  Bun.spawn(paireCliSpawnArgs("_review-serve", session.id), {
    cwd: session.repoRoot,
    env: { ...ctx.env, PAIRE_HOME: ctx.paireHome },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    detached: true,
  }).unref();

  const state = await waitForReviewServerState(statePath);
  await ctx.openBrowser(state.url);
  ctx.stdout(reviewUiMessage(state.url));
}

function createReviewServer(session: SessionRow, ctx: Context, token: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: REVIEW_PORT,
    routes: {
      "/": reviewApp,
      "/api/review": (request: Request) =>
        authenticatedReviewRequest(request, token, () =>
          handleReviewRequest(request, session, ctx),
        ),
      "/api/review/diff": (request: Request) =>
        authenticatedReviewRequest(request, token, () =>
          handleReviewDiffRequest(request, session, ctx),
        ),
      "/api/claims/:claimId/evidence-diff": (request: Request) =>
        authenticatedReviewRequest(request, token, () =>
          handleEvidenceDiffRequest(request, session, ctx),
        ),
      "/api/claims/:claimId/human-status": (request: Request) =>
        authenticatedReviewRequest(request, token, () =>
          handleHumanStatusRequest(request, session, ctx),
        ),
      "/api/claims/:claimId/comment": (request: Request) =>
        authenticatedReviewRequest(request, token, () =>
          handleCommentRequest(request, session, ctx),
        ),
    },
  });
}

async function reviewServeCommand(sessionId: string, ctx: Context) {
  const session = ctx.db
    .query<SessionRow, [string]>("select * from sessions where id = ?")
    .get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const statePath = reviewServerStatePath(ctx, sessionId);
  ensurePrivateDirectory(dirname(statePath));

  const token = createReviewToken();
  const server = createReviewServer(session, ctx, token);
  const port = server.port;
  if (port == null) {
    throw new Error("Review UI server did not bind to a port.");
  }
  const url = reviewUiUrl(port, token);
  writeFileSync(
    statePath,
    JSON.stringify({
      pid: process.pid,
      port,
      url,
      token,
      sessionId,
      repoRoot: session.repoRoot,
      startedAt: Date.now(),
    } satisfies ReviewServerState),
  );
  ensurePrivateFile(statePath);

  const shutdown = () => {
    server.stop();
    try {
      unlinkSync(statePath);
    } catch {
      // ignore missing state file
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => undefined);
}

function reviewServerStatePath(ctx: Context, sessionId: string) {
  return join(ctx.paireHome, "review-servers", `${sessionId}.json`);
}

function readReviewServerState(path: string) {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewServerState>;
    if (
      typeof state.pid !== "number" ||
      typeof state.url !== "string" ||
      typeof state.token !== "string"
    ) {
      return null;
    }
    return state as ReviewServerState;
  } catch {
    return null;
  }
}

async function waitForReviewServerState(path: string) {
  const deadline = Date.now() + REVIEW_SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readReviewServerState(path);
    if (state?.url) return state;
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

function createReviewToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(REVIEW_TOKEN_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
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
  token: string,
  handler: () => Promise<Response> | Response,
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
  if (request.headers.get(REVIEW_TOKEN_HEADER) !== token) {
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
    }));
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
    .query<AgentClaim, [string]>(
      "select id, threadId, title, description, beforeText as before, afterText as after, agentStatus, humanStatus, updatedAt from claims where threadId = ? order by updatedAt desc, rowid desc",
    )
    .all(threadDbId)
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
      fingerprint text
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
  addNullableColumn(db, "sessions", "projectKey", "text");
  addNullableColumn(db, "revisions", "packetJson", "text");
  addNullableColumn(db, "revisions", "packetExportPath", "text");
  addNullableColumn(db, "revisions", "resultPath", "text");
  addNullableColumn(db, "revisions", "totalDiffArtifactId", "text");
  addNullableColumn(db, "claims", "title", "text");
  addNullableColumn(db, "claims", "description", "text");
  addNullableColumn(db, "claims", "beforeText", "text");
  addNullableColumn(db, "claims", "afterText", "text");
  addNullableColumn(db, "claim_evidences", "changeText", "text");
  migrateClaimsDropLegacyTextColumn(db);
  dropColumnIfExists(db, "claim_evidences", "beforeText");
  dropColumnIfExists(db, "claim_evidences", "afterText");
  dropColumnIfExists(db, "change_threads", "status");
  migrateSessionsToBranchScope(db);
  scopeReviewIds(db);
}

function migrateSessionsToBranchScope(db: Database) {
  const table = db
    .query<{ sql: string }, []>(
      "select sql from sqlite_master where type = 'table' and name = 'sessions'",
    )
    .get();
  if (!/\brepoRoot\s+text\s+not\s+null\s+unique\b/i.test(table?.sql ?? "")) {
    return;
  }

  db.exec(`
    create table sessions_next (
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
    insert into sessions_next (id, repoRoot, projectKey, goal, baseRef, baseCommit, branch, upstream, createdAt, updatedAt)
      select id, repoRoot, projectKey, goal, baseRef, baseCommit, branch, upstream, createdAt, updatedAt
        from sessions;
    drop table sessions;
    alter table sessions_next rename to sessions;
  `);
}

function addNullableColumn(
  db: Database,
  table: string,
  column: string,
  type: string,
) {
  try {
    db.exec(`alter table ${table} add column ${column} ${type}`);
  } catch {
    // SQLite throws when the column already exists.
  }
}

function tableHasColumn(db: Database, table: string, column: string) {
  return db
    .query<{ name: string }, []>(`pragma table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function dropColumnIfExists(db: Database, table: string, column: string) {
  if (!tableHasColumn(db, table, column)) return;
  db.exec(`alter table ${table} drop column ${column}`);
}

function migrateClaimsDropLegacyTextColumn(db: Database) {
  if (!tableHasColumn(db, "claims", "text")) return;
  db.exec(`
    create table claims_next (
      id text primary key,
      threadId text not null,
      sessionId text not null,
      title text not null,
      description text not null default '',
      beforeText text,
      afterText text,
      agentStatus text not null,
      humanStatus text not null,
      updatedAt integer not null
    );
    insert into claims_next (
      id, threadId, sessionId, title, description, beforeText, afterText,
      agentStatus, humanStatus, updatedAt
    )
    select
      id,
      threadId,
      sessionId,
      coalesce(nullif(trim(title), ''), text),
      coalesce(description, ''),
      beforeText,
      afterText,
      agentStatus,
      humanStatus,
      updatedAt
    from claims;
    drop table claims;
    alter table claims_next rename to claims;
  `);
}

function scopeReviewIds(db: Database) {
  db.exec(`
    update claim_evidences
       set claimId = (
         select claims.sessionId || ':' || claim_evidences.claimId
           from claims
          where claims.id = claim_evidences.claimId
       )
     where exists (
         select 1
           from claims
          where claims.id = claim_evidences.claimId
            and instr(claims.id, claims.sessionId || ':') != 1
       );

    update human_review_marks
       set claimId = (
         select claims.sessionId || ':' || human_review_marks.claimId
           from claims
          where claims.id = human_review_marks.claimId
       )
     where exists (
         select 1
           from claims
          where claims.id = human_review_marks.claimId
            and instr(claims.id, claims.sessionId || ':') != 1
       );

    update claims
       set threadId = sessionId || ':' || threadId
     where instr(threadId, sessionId || ':') != 1;

    update claims
       set id = sessionId || ':' || id
     where instr(id, sessionId || ':') != 1;

    update change_threads
       set id = sessionId || ':' || id
     where instr(id, sessionId || ':') != 1;
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

function getActiveClaims(db: Database, sessionId: string) {
  const rows = db
    .query<AgentClaim & { threadTitle: string }, [string]>(
      `select claims.id, claims.threadId, claims.title, claims.description,
              claims.beforeText as before, claims.afterText as after,
              claims.agentStatus, claims.humanStatus, change_threads.title as threadTitle
       from claims join change_threads on change_threads.id = claims.threadId
       where claims.sessionId = ? and claims.agentStatus != 'superseded'
       order by change_threads.updatedAt desc, change_threads.rowid desc, claims.updatedAt desc, claims.rowid desc`,
    )
    .all(sessionId);
  return rows.map((claim) => ({
    ...claim,
    ...normalizeStoredClaim(claim),
    id: publicDbId(sessionId, claim.id),
    threadId: publicDbId(sessionId, claim.threadId),
    evidences: db
      .query<
      AgentEvidence & { revisionId: string },
      [string]
    >("select filePath, startLine, endLine, symbol, fingerprint, revisionId, changeText as change from claim_evidences where claimId = ? order by filePath, startLine")
      .all(claim.id),
  }));
}

function scopedDbId(sessionId: string, publicId: string) {
  return `${sessionId}:${publicId}`;
}

function publicDbId(sessionId: string, dbId: string) {
  const prefix = `${sessionId}:`;
  return dbId.startsWith(prefix) ? dbId.slice(prefix.length) : dbId;
}

function validateApplyPayload(value: unknown): AgentApplyPayload {
  if (!value || typeof value !== "object")
    throw new Error("Agent result must be an object.");
  const payload = value as AgentApplyPayload;
  for (const key of ["packetId", "sessionId", "revisionId", "gitFingerprint"]) {
    if (typeof payload[key as keyof AgentApplyPayload] !== "string") {
      throw new Error(`Agent result is missing ${key}.`);
    }
  }
  if (!Array.isArray(payload.threads))
    throw new Error("Agent result threads must be an array.");
  if (payload.threads.length > MAX_THREADS_PER_APPLY) {
    throw new Error(`Agent result has too many threads; max ${MAX_THREADS_PER_APPLY}.`);
  }
  for (const thread of payload.threads) {
    validatePublicId(thread.id, "Thread id");
    validateTextField(thread.title, "Thread title", MAX_TITLE_CHARS);
    if (thread.summary != null) {
      validateOptionalTextField(thread.summary, "Thread summary", MAX_SUMMARY_CHARS);
    }
    if (!Array.isArray(thread.claims)) {
      throw new Error("Each thread needs id, title, and claims.");
    }
    if (thread.claims.length > MAX_CLAIMS_PER_THREAD) {
      throw new Error(`Thread has too many claims; max ${MAX_CLAIMS_PER_THREAD}.`);
    }
    for (const claim of thread.claims) {
      validatePublicId(claim.id, "Claim id");
      validatePublicId(claim.threadId, "Claim threadId");
      if ("text" in claim && (claim as { text?: unknown }).text != null) {
        throw new Error("Claim text is no longer supported; use title and description.");
      }
      validateTextField(claim.title, "Claim title", MAX_TITLE_CHARS);
      if (claim.description != null) {
        validateOptionalTextField(
          claim.description,
          "Claim description",
          MAX_DESCRIPTION_CHARS,
        );
      }
      if (!VALID_AGENT_STATUSES.has(claim.agentStatus))
        throw new Error(`Invalid agentStatus: ${claim.agentStatus}`);
      if (claim.humanStatus && !VALID_HUMAN_STATUSES.has(claim.humanStatus)) {
        throw new Error(`Invalid humanStatus: ${claim.humanStatus}`);
      }
      if (!Array.isArray(claim.evidences))
        throw new Error("Each claim needs evidences[].");
      if (claim.before != null) {
        validateOptionalTextField(claim.before, "Claim before", MAX_BEHAVIOR_COPY_CHARS);
      }
      if (claim.after != null) {
        validateOptionalTextField(claim.after, "Claim after", MAX_BEHAVIOR_COPY_CHARS);
      }
      if (claim.evidences.length > MAX_EVIDENCES_PER_CLAIM) {
        throw new Error(
          `Claim has too many evidences; max ${MAX_EVIDENCES_PER_CLAIM}.`,
        );
      }
      for (const evidence of claim.evidences) {
        validateEvidencePath(evidence.filePath);
        validateEvidenceRange(evidence.startLine, evidence.endLine);
        if ("before" in evidence || "after" in evidence) {
          throw new Error(
            "Evidence before/after are no longer supported; set claim before/after and evidence change.",
          );
        }
        validateTextField(
          evidence.change,
          "Evidence change",
          MAX_EVIDENCE_CHANGE_CHARS,
        );
      }
    }
  }
  return normalizeApplyPayload(payload);
}

function validatePublicId(value: unknown, label: string) {
  validateTextField(value, label, MAX_ID_CHARS);
  if (!/^[a-zA-Z0-9._:-]+$/.test(value as string)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function validateTextField(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} is too long; max ${maxLength} characters.`);
  }
}

function validateOptionalTextField(
  value: unknown,
  label: string,
  maxLength: number,
) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} is too long; max ${maxLength} characters.`);
  }
}

function validateEvidencePath(value: unknown) {
  validateTextField(value, "Evidence filePath", MAX_FILE_PATH_CHARS);
  const path = value as string;
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.split(/[\\/]+/).some((part) => part === "..")
  ) {
    throw new Error("Evidence filePath must be a relative repository path.");
  }
}

function validateEvidenceRange(startLine: unknown, endLine: unknown) {
  if (
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine)
  ) {
    throw new Error("Evidence line range is invalid.");
  }
  const start = startLine;
  const end = endLine;
  if (start < 1 || end < start || end > MAX_EVIDENCE_LINE) {
    throw new Error("Evidence line range is invalid.");
  }
  if (end - start + 1 > MAX_EVIDENCE_SPAN_LINES) {
    throw new Error(
      `Evidence line range is too large; max ${MAX_EVIDENCE_SPAN_LINES} lines.`,
    );
  }
}

function normalizeNullableCopy(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeApplyPayload(payload: AgentApplyPayload): AgentApplyPayload {
  return {
    ...payload,
    threads: payload.threads.map((thread) => ({
      ...thread,
      claims: thread.claims.map((claim) => ({
        ...claim,
        before: normalizeNullableCopy(claim.before),
        after: normalizeNullableCopy(claim.after),
        evidences: claim.evidences.map((evidence) => ({
          ...evidence,
          change: evidence.change.trim(),
        })),
      })),
    })),
  };
}

function normalizeClaimCopy(claim: Pick<AgentClaim, "title" | "description">) {
  return {
    title: claim.title.trim(),
    description: claim.description?.trim() ?? "",
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
  return gitCommand(["diff", `${gitDiffBaseRef(base)}..HEAD`], repoRoot, {
    allowFail,
  });
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
        const text = summarize
          ? `[summarized: ${file.name} is too large or generated; inspect the artifact diff path instead]`
          : annotated!.annotatedText.slice(0, MAX_INLINE_SNIPPET_CHARS);
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
          addedRanges: summarize
            ? undefined
            : addedLineRanges(annotated!.lines),
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
    "  review [--apply <file> | --stdin] [--no-open]",
    "  it",
    "  status",
    "  sync",
    "  reset",
    "  install",
  ].join("\n");
}
