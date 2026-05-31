import { parsePatchFiles } from "@pierre/diffs";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

type HumanStatus = "unreviewed" | "accepted" | "concern" | "irrelevant";

type AgentEvidence = {
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  fingerprint?: string;
  revisionId?: string;
};

type AgentClaim = {
  id: string;
  threadId: string;
  text: string;
  agentStatus: ClaimStatus;
  humanStatus?: HumanStatus;
  evidences: AgentEvidence[];
};

type AgentThread = {
  id: string;
  title: string;
  summary?: string;
  status?: string;
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
  summarized: boolean;
};

const LARGE_DIFF_BYTES = 30_000;
const MAX_INLINE_SNIPPET_CHARS = 4_000;
const MAX_TOTAL_SNIPPET_CHARS = 18_000;
const REVIEW_PORT = 0;
const VALID_AGENT_STATUSES = new Set([
  "new",
  "unchanged",
  "evidence_moved",
  "amended",
  "invalidated",
  "superseded",
]);
const VALID_HUMAN_STATUSES = new Set([
  "unreviewed",
  "accepted",
  "concern",
  "irrelevant",
]);

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
        await reviewCommand(rest, ctx);
        return 0;
      case "status":
        await statusCommand(ctx);
        return 0;
      case "sync":
        await syncCommand(ctx);
        return 0;
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
  mkdirSync(paireHome, { recursive: true });
  mkdirSync(join(paireHome, "artifacts"), { recursive: true });
  const db = new Database(join(paireHome, "paire.db"));
  migrate(db);
  return {
    cwd,
    env,
    paireHome,
    artifactsDir: join(paireHome, "artifacts"),
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
  const baseRef = stringFlag(parsed, "base") ?? detectBaseRef(git.repoRoot);
  const baseCommit =
    gitCommand(["merge-base", "HEAD", baseRef], git.repoRoot, {
      allowFail: true,
    }).trim() || git.head;
  const goal = stringFlag(parsed, "goal") ?? null;
  const existing = getSession(ctx.db, git.repoRoot);
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
  } else {
    ctx.db
      .prepare(
        `insert into sessions (id, repoRoot, goal, baseRef, baseCommit, branch, upstream, createdAt, updatedAt)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        git.repoRoot,
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
    ctx.db
      .prepare(
        `insert into revisions (id, sessionId, number, state, gitFingerprint, packetArtifactId, totalDiffArtifactId, createdAt, appliedAt)
         values (?, ?, ?, 'applied', ?, null, null, ?, ?)`,
      )
      .run(
        `rev_${crypto.randomUUID()}`,
        sessionId,
        0,
        git.head,
        now,
        now,
      );
  }

  ctx.stdout(
    [
      "Paire session ready.",
      `Session ID: ${sessionId}`,
      `Base branch/ref: ${baseRef}`,
      `Base commit: ${baseCommit}`,
      `Current branch: ${git.branch}`,
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
  const session = getSession(ctx.db, git.repoRoot);
  if (!session) {
    const base = detectBaseRef(git.repoRoot);
    ctx.stdout(`No Paire session found.\nRun:\npaire start --base ${base}`);
    return;
  }
  if (!git.clean) {
    ctx.stdout(dirtyWorktreeMessage(git));
    return;
  }
  const lastApplied = getLastAppliedRevision(ctx.db, session.id);
  if (lastApplied?.gitFingerprint === git.fingerprint) {
    await printStatusAndOpen(session, git, ctx);
    return;
  }

  const packet = createPendingPacket(ctx, session, git, lastApplied);
  ctx.stdout(
    [
      "PAIRE_AGENT_ACTION_REQUIRED",
      "",
      `Paire detected changes since revision ${lastApplied?.id ?? "none"}.`,
      "Analyze this packet:",
      packet.path,
      "",
      "Then write the review update JSON and run:",
      `paire review --apply ${packet.resultPath}`,
    ].join("\n"),
  );
}

async function applyReviewCommand(
  applyPath: string | undefined,
  useStdin: boolean,
  noOpen: boolean,
  ctx: Context,
) {
  const raw = useStdin
    ? await new Response(Bun.stdin).text()
    : readFileSync(
        resolveRequiredPath(applyPath, "Missing --apply file."),
        "utf8",
      );
  const payload = validateApplyPayload(JSON.parse(raw));
  const session = ctx.db
    .query<SessionRow, [string]>("select * from sessions where id = ?")
    .get(payload.sessionId);
  if (!session) throw new Error("Session not found for apply payload.");
  const git = getGitState(session.repoRoot);
  if (!git.clean) {
    throw new Error(
      "Paire reviews committed code only. Commit or discard the current worktree changes, then run paire review --apply again.",
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

  const apply = ctx.db.transaction((value: AgentApplyPayload) => {
    for (const thread of value.threads) {
      ctx.db
        .prepare(
          `insert into change_threads (id, sessionId, title, summary, status, updatedAt)
           values (?, ?, ?, ?, ?, ?)
           on conflict(id) do update set title = excluded.title, summary = excluded.summary, status = excluded.status, updatedAt = excluded.updatedAt`,
        )
        .run(
          thread.id,
          session.id,
          thread.title,
          thread.summary ?? "",
          thread.status ?? "active",
          Date.now(),
        );
      for (const claim of thread.claims) {
        ctx.db
          .prepare(
            `insert into claims (id, threadId, sessionId, text, agentStatus, humanStatus, updatedAt)
             values (?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set threadId = excluded.threadId, text = excluded.text,
               agentStatus = excluded.agentStatus, humanStatus = excluded.humanStatus, updatedAt = excluded.updatedAt`,
          )
          .run(
            claim.id,
            thread.id,
            session.id,
            claim.text,
            claim.agentStatus,
            claim.humanStatus ?? "unreviewed",
            Date.now(),
          );
        ctx.db
          .prepare("delete from claim_evidences where claimId = ?")
          .run(claim.id);
        for (const evidence of claim.evidences) {
          ctx.db
            .prepare(
              `insert into claim_evidences (id, claimId, revisionId, filePath, startLine, endLine, symbol, fingerprint)
               values (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `ev_${crypto.randomUUID()}`,
              claim.id,
              revision.id,
              evidence.filePath,
              evidence.startLine,
              evidence.endLine,
              evidence.symbol ?? null,
              evidence.fingerprint ?? null,
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
  const session = getSession(ctx.db, git.repoRoot);
  ctx.stdout(
    session
      ? formatStatus(ctx.db, session, git)
      : `No Paire session found.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`,
  );
}

async function syncCommand(ctx: Context) {
  const git = getGitState(ctx.cwd);
  const session = getSession(ctx.db, git.repoRoot);
  const status = session
    ? formatStatus(ctx.db, session, git)
    : `No Paire session found.\nRun:\npaire start --base ${detectBaseRef(git.repoRoot)}`;
  ctx.stdout(
    `${status}\n\nCloud sync is not configured in this local build. Run paire review to update or open the local review.`,
  );
}

function createPendingPacket(
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
  const packetId = `pkt_${crypto.randomUUID()}`;
  const totalDiffArtifactPath = writeArtifact(
    ctx,
    "total-diff",
    `${packetId}.total.diff`,
    totalDiff,
  );
  const incrementalDiffArtifactPath = writeArtifact(
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
        "Array<{ id, title, summary?, status?, claims: Array<{ id, threadId, text, agentStatus, humanStatus?, evidences[] }> }>",
    },
    rules: [
      "Update existing claims before creating new ones.",
      "Do not create new claims for line movement, formatting, renames, or helper extraction unless meaning changed.",
      "Set agentStatus to one of: new, unchanged, evidence_moved, amended, invalidated, superseded.",
      "Put every evidence span under the claim that depends on it.",
    ],
  };
  const packetPath = writeArtifact(
    ctx,
    "packet",
    `${packetId}.packet.json`,
    JSON.stringify(packet, null, 2),
  );
  const resultPath = join(dirname(packetPath), `${packetId}.agent-result.json`);
  if (!existing) {
    const packetArtifactId = `art_${crypto.randomUUID()}`;
    ctx.db
      .prepare(
        "insert into artifact_refs (id, kind, path, createdAt) values (?, 'packet', ?, ?)",
      )
      .run(packetArtifactId, packetPath, Date.now());
    ctx.db
      .prepare(
        `insert into revisions (id, sessionId, number, state, gitFingerprint, packetArtifactId, totalDiffArtifactId, createdAt, appliedAt)
         values (?, ?, ?, 'pending_agent', ?, ?, ?, ?, null)`,
      )
      .run(
        revisionId,
        session.id,
        number,
        git.fingerprint,
        packetArtifactId,
        totalDiffArtifactId,
        Date.now(),
      );
  }
  return { path: packetPath, resultPath };
}

function writeArtifact(
  ctx: Context,
  kind: string,
  filename: string,
  contents: string,
) {
  const directory = join(ctx.artifactsDir, kind);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, contents, "utf8");
  return path;
}

function insertArtifactRef(db: Database, kind: string, path: string) {
  const id = `art_${crypto.randomUUID()}`;
  db.prepare(
    "insert into artifact_refs (id, kind, path, createdAt) values (?, ?, ?, ?)",
  ).run(id, kind, path, Date.now());
  return id;
}

function formatStatus(db: Database, session: SessionRow, git: GitState) {
  const lastApplied = getLastAppliedRevision(db, session.id);
  const pending = getPendingRevision(db, session.id);
  const burden = reviewBurden(db, session.id);
  return [
    "Paire status",
    `Session: ${session.id}`,
    `Base: ${session.baseRef} @ ${session.baseCommit}`,
    `Branch/upstream: ${git.branch}${git.upstream ? ` / ${git.upstream}` : " / (none)"}`,
    `Current git fingerprint: ${git.fingerprint}`,
    `Last applied Paire revision: ${lastApplied ? `${lastApplied.id} (${lastApplied.gitFingerprint})` : "(none)"}`,
    `Pending agent update: ${pending ? `${pending.id} (${pending.gitFingerprint})` : "(none)"}`,
    `Review burden: ${burden}`,
    git.clean
      ? "Suggested inspection: git diff --stat"
      : "Review blocked: Paire reviews committed code only. Commit or discard worktree changes before running paire review.",
  ].join("\n");
}

function dirtyWorktreeMessage(git: GitState) {
  return [
    "PAIRE_NEEDS_COMMITTED_CHANGES",
    "",
    "Paire reviews committed code only.",
    "The current worktree has uncommitted changes, so Paire will not create a review packet or open a stale review.",
    "",
    `Current branch: ${git.branch}`,
    `Current HEAD: ${git.head}`,
    "",
    "Safe inspection:",
    "git status --short",
    "git diff --stat",
    "",
    "Commit or discard the worktree changes, then run:",
    "paire review",
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

async function openReviewUi(ctx: Context, session: SessionRow, git: GitState) {
  const data = buildReviewData(ctx.db, session, git);
  const html = renderReviewHtml(data);
  if (ctx.env.PAIRE_BROWSER_HTML_CAPTURE) {
    writeFileSync(ctx.env.PAIRE_BROWSER_HTML_CAPTURE, html, "utf8");
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: REVIEW_PORT,
    fetch: (request: Request) => handleReviewRequest(request, html, data, ctx),
  });
  const url = `http://127.0.0.1:${server.port}/`;
  await ctx.openBrowser(url);
  if (ctx.env.PAIRE_BROWSER_CAPTURE) {
    server.stop();
    return;
  }
  ctx.stdout(`Review UI: ${url}\nPress Ctrl+C to stop.`);
  await new Promise(() => undefined);
}

async function handleReviewRequest(
  request: Request,
  html: string,
  data: ReturnType<typeof buildReviewData>,
  ctx: Context,
) {
  const url = new URL(request.url);
  if (url.pathname === "/api/review") {
    return Response.json(data);
  }
  const statusMatch = /^\/api\/claims\/([^/]+)\/human-status$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && statusMatch) {
    const claimId = decodeURIComponent(statusMatch[1] ?? "");
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
      .run(payload.humanStatus, Date.now(), claimId, data.session.id);
    if (update.changes === 0) {
      return Response.json({ error: "Claim not found." }, { status: 404 });
    }
    ctx.db
      .prepare(
        "insert into human_review_marks (id, claimId, humanStatus, note, updatedAt) values (?, ?, ?, null, ?)",
      )
      .run(
        `mark_${crypto.randomUUID()}`,
        claimId,
        payload.humanStatus,
        Date.now(),
      );
    return Response.json({ ok: true });
  }
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function buildReviewData(db: Database, session: SessionRow, git: GitState) {
  const threads = db
    .query<
      { id: string; title: string; summary: string; status: string },
      [string]
    >(
      "select id, title, summary, status from change_threads where sessionId = ? order by updatedAt desc",
    )
    .all(session.id)
    .map((thread) => ({
      ...thread,
      claims: getClaimsForThread(db, thread.id),
    }));
  return {
    session,
    git,
    burden: reviewBurden(db, session.id),
    threads,
  };
}

function getClaimsForThread(db: Database, threadId: string) {
  return db
    .query<AgentClaim, [string]>(
      "select id, threadId, text, agentStatus, humanStatus from claims where threadId = ? order by updatedAt desc",
    )
    .all(threadId)
    .map((claim) => ({
      ...claim,
      evidences: db
        .query<
        AgentEvidence & { revisionId: string },
        [string]
      >("select filePath, startLine, endLine, symbol, fingerprint, revisionId from claim_evidences where claimId = ? order by filePath, startLine")
        .all(claim.id),
    }));
}

function renderReviewHtml(data: ReturnType<typeof buildReviewData>) {
  const body = renderToStaticMarkup(
    React.createElement(
      "main",
      { className: "mx-auto max-w-5xl px-6 py-8 font-sans text-slate-950" },
      React.createElement(
        "h1",
        { className: "text-2xl font-semibold" },
        "Paire Review",
      ),
      React.createElement(
        "p",
        { className: "mt-1 text-sm text-slate-500" },
        data.session.goal ?? "No goal set",
      ),
      React.createElement(
        "section",
        { className: "mt-6 rounded-lg border border-slate-200 bg-white p-4" },
        React.createElement(
          "h2",
          {
            className:
              "text-sm font-medium uppercase tracking-wide text-slate-500",
          },
          "Review burden",
        ),
        React.createElement("p", { className: "mt-2 text-lg" }, data.burden),
      ),
      ...data.threads.map((thread) =>
        React.createElement(
          "section",
          {
            key: thread.id,
            className: "mt-4 rounded-lg border border-slate-200 bg-white p-4",
          },
          React.createElement(
            "h2",
            { className: "text-lg font-semibold" },
            thread.title,
          ),
          React.createElement(
            "p",
            { className: "mt-1 text-sm text-slate-600" },
            thread.summary,
          ),
          ...thread.claims.map((claim) =>
            React.createElement(
              "article",
              { key: claim.id, className: "mt-3 rounded-md bg-slate-50 p-3" },
              React.createElement(
                "div",
                { className: "text-sm font-medium" },
                claim.text,
              ),
              React.createElement(
                "div",
                { className: "mt-1 text-xs text-slate-500" },
                `${claim.agentStatus} / ${claim.humanStatus ?? "unreviewed"}`,
              ),
              React.createElement(
                "ul",
                {
                  className: "mt-2 grid gap-1 text-xs font-mono text-slate-600",
                },
                ...claim.evidences.map((evidence) =>
                  React.createElement(
                    "li",
                    {
                      key: `${evidence.filePath}:${evidence.startLine}-${evidence.endLine}`,
                    },
                    `${evidence.filePath}:${evidence.startLine}-${evidence.endLine}${evidence.symbol ? ` (${evidence.symbol})` : ""}`,
                  ),
                ),
              ),
              React.createElement(
                "div",
                { className: "mt-3 flex flex-wrap gap-2" },
                ...(["accepted", "concern", "irrelevant"] as const).map(
                  (status) =>
                    React.createElement(
                      "button",
                      {
                        key: status,
                        type: "button",
                        "data-claim-id": claim.id,
                        "data-human-status": status,
                        className:
                          "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100",
                      },
                      status,
                    ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paire Review</title><style>${reviewCss()}</style></head><body class="bg-slate-100">${body}<script>
window.__PAIRE_REACT_PREVIEW__=true;
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-claim-id][data-human-status]");
  if (!button) return;
  const claimId = button.getAttribute("data-claim-id");
  const humanStatus = button.getAttribute("data-human-status");
  const response = await fetch("/api/claims/" + encodeURIComponent(claimId) + "/human-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ humanStatus })
  });
  if (response.ok) {
    button.parentElement.querySelectorAll("button").forEach((node) => node.classList.remove("bg-slate-900", "text-white"));
    button.classList.add("bg-slate-900", "text-white");
  }
});
</script></body></html>`;
}

function reviewCss() {
  return `
*{box-sizing:border-box}
body{margin:0;background:#f1f5f9;color:#020617}
.font-sans{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}
.mx-auto{margin-left:auto;margin-right:auto}
.max-w-5xl{max-width:64rem}
.px-6{padding-left:1.5rem;padding-right:1.5rem}.py-8{padding-top:2rem;padding-bottom:2rem}
.p-4{padding:1rem}.p-3{padding:.75rem}.px-2{padding-left:.5rem;padding-right:.5rem}.py-1{padding-top:.25rem;padding-bottom:.25rem}
.mt-1{margin-top:.25rem}.mt-2{margin-top:.5rem}.mt-3{margin-top:.75rem}.mt-4{margin-top:1rem}.mt-6{margin-top:1.5rem}
.text-2xl{font-size:1.5rem;line-height:2rem}.text-lg{font-size:1.125rem;line-height:1.75rem}.text-sm{font-size:.875rem;line-height:1.25rem}.text-xs{font-size:.75rem;line-height:1rem}
.font-semibold{font-weight:600}.font-medium{font-weight:500}.uppercase{text-transform:uppercase}.tracking-wide{letter-spacing:.025em}
.text-slate-950{color:#020617}.text-slate-700{color:#334155}.text-slate-600{color:#475569}.text-slate-500{color:#64748b}.text-white{color:#fff}
.bg-slate-100{background:#f1f5f9}.bg-white{background:#fff}.bg-slate-50{background:#f8fafc}.bg-slate-900{background:#0f172a}
.border{border:1px solid}.border-slate-200{border-color:#e2e8f0}.border-slate-300{border-color:#cbd5e1}
.rounded-lg{border-radius:.5rem}.rounded-md{border-radius:.375rem}
.grid{display:grid}.gap-1{gap:.25rem}.gap-2{gap:.5rem}.flex{display:flex}.flex-wrap{flex-wrap:wrap}
button{cursor:pointer}.hover\\:bg-slate-100:hover{background:#f1f5f9}
ul{padding-left:1rem}
`;
}

async function openBrowser(
  url: string,
  env: Record<string, string | undefined>,
) {
  if (env.PAIRE_BROWSER_CAPTURE) {
    writeFileSync(env.PAIRE_BROWSER_CAPTURE, `${url}\n`, { flag: "a" });
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

function migrate(db: Database) {
  db.exec(`
    create table if not exists sessions (
      id text primary key,
      repoRoot text not null unique,
      goal text,
      baseRef text not null,
      baseCommit text not null,
      branch text not null,
      upstream text,
      createdAt integer not null,
      updatedAt integer not null
    );
    create table if not exists revisions (
      id text primary key,
      sessionId text not null,
      number integer not null,
      state text not null,
      gitFingerprint text not null,
      packetArtifactId text,
      totalDiffArtifactId text,
      createdAt integer not null,
      appliedAt integer
    );
    create table if not exists change_threads (
      id text primary key,
      sessionId text not null,
      title text not null,
      summary text not null,
      status text not null,
      updatedAt integer not null
    );
    create table if not exists claims (
      id text primary key,
      threadId text not null,
      sessionId text not null,
      text text not null,
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
  addNullableColumn(db, "revisions", "totalDiffArtifactId", "text");
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

function getSession(db: Database, repoRoot: string) {
  return db
    .query<SessionRow, [string]>("select * from sessions where repoRoot = ?")
    .get(repoRoot);
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
      `select claims.id, claims.threadId, claims.text, claims.agentStatus, claims.humanStatus, change_threads.title as threadTitle
       from claims join change_threads on change_threads.id = claims.threadId
       where claims.sessionId = ? and claims.agentStatus != 'superseded'
       order by change_threads.updatedAt desc, claims.updatedAt desc`,
    )
    .all(sessionId);
  return rows.map((claim) => ({
    ...claim,
    evidences: db
      .query<
      AgentEvidence & { revisionId: string },
      [string]
    >("select filePath, startLine, endLine, symbol, fingerprint, revisionId from claim_evidences where claimId = ? order by filePath, startLine")
      .all(claim.id),
  }));
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
  for (const thread of payload.threads) {
    if (!thread.id || !thread.title || !Array.isArray(thread.claims)) {
      throw new Error("Each thread needs id, title, and claims.");
    }
    for (const claim of thread.claims) {
      if (!claim.id || !claim.threadId || !claim.text)
        throw new Error("Each claim needs id, threadId, and text.");
      if (!VALID_AGENT_STATUSES.has(claim.agentStatus))
        throw new Error(`Invalid agentStatus: ${claim.agentStatus}`);
      if (claim.humanStatus && !VALID_HUMAN_STATUSES.has(claim.humanStatus)) {
        throw new Error(`Invalid humanStatus: ${claim.humanStatus}`);
      }
      if (!Array.isArray(claim.evidences))
        throw new Error("Each claim needs evidences[].");
      for (const evidence of claim.evidences) {
        if (
          !evidence.filePath ||
          !Number.isFinite(evidence.startLine) ||
          !Number.isFinite(evidence.endLine)
        ) {
          throw new Error(
            "Each evidence needs filePath, startLine, and endLine.",
          );
        }
      }
    }
  }
  return payload;
}

function getGitState(cwd: string): GitState {
  const repoRoot = gitCommand(["rev-parse", "--show-toplevel"], cwd).trim();
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
        const text = summarize
          ? `[summarized: ${file.name} is too large or generated; inspect the artifact diff path instead]`
          : rawHunkText(raw, hunk.hunkSpecs ?? "").slice(
              0,
              MAX_INLINE_SNIPPET_CHARS,
            );
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
  ].join("\n");
}
