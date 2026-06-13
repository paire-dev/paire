import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Fixture = {
  root: string;
  repo: string;
  home: string;
  browserCapture: string;
  htmlCapture: string;
};

let fixtures: Fixture[] = [];
const PREFERRED_REVIEW_PORT = 22222;

beforeEach(() => {
  fixtures = [];
});

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("agent loop creates a packet, applies hardcoded claims, and opens browser only after apply", () => {
  const fixture = createFixtureRepo();

  const start = runPaire(fixture, [
    "start",
    "--base",
    "main",
    "--goal",
    "Add workspace validation",
  ]);
  expect(start.exitCode).toBe(0);
  expect(start.stdout).toContain("Session ID:");
  expect(start.stdout).toContain("Next: paire review");

  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) {",
      "    throw new Error('Unauthorized');",
      "  }",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add workspace validation");

  const review = runPaire(fixture, ["review"]);
  expect(review.exitCode).toBe(0);
  expect(review.stdout).toContain("Action required");
  expect(review.stdout).toContain("Step 1 — Read the annotated diff");
  expect(review.stdout).toContain("annotated-diff.txt");
  expect(review.stdout).toContain("Step 2 — Edit the review draft IN PLACE");
  expect(review.stdout).toContain("Step 3 — Apply");
  expect(existsSync(fixture.browserCapture)).toBe(false);

  const packetPath = extractPacketPath(review.stdout);
  expect(packetPath).toContain(`${fixture.home}/projects/`);
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  const annotatedDiffPath = join(dirname(packetPath), "annotated-diff.txt");
  expect(existsSync(annotatedDiffPath)).toBe(true);
  const annotatedDiff = readFileSync(annotatedDiffPath, "utf8");
  expect(annotatedDiff).toContain("=== src/app.ts ===");
  expect(annotatedDiff).toMatch(/\d+\|\+/);
  expect(annotatedDiff).toMatch(/-\d+\|-/);
  expect(review.stdout).toContain("review-draft.json");
  expect(review.stdout).toContain(packet.currentFingerprint);
  const agentResultPath = join(fixture.root, "review-draft-mutated.json");
  writeFileSync(
    agentResultPath,
    JSON.stringify(hardcodedAgentResult(packet), null, 2),
  );

  const apply = runPaire(fixture, ["review", "--apply", agentResultPath, "--open"]);
  expect(apply.exitCode).toBe(0);
  expect(apply.stdout).toContain("Review burden:");
  expect(apply.stdout).toContain("Open this URL in the browser:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );
  const html = readFileSync(fixture.htmlCapture, "utf8");
  expect(html).toContain('src="./main.tsx"');
  expect(html).not.toContain("cdn.tailwindcss.com");

  const db = new Database(join(fixture.home, "paire.db"));
  const pending = db
    .query<
      {
        packetJson: string | null;
        packetExportPath: string | null;
        packetArtifactId: string | null;
      },
      [string]
    >(
      "select packetJson, packetExportPath, packetArtifactId from revisions where id = ?",
    )
    .get(packet.revisionId);
  expect(pending?.packetJson).toContain(packet.packetId);
  expect(pending?.packetExportPath).toBe(packetPath);
  expect(pending?.packetArtifactId).toBe(null);
  const claims = db
    .query<{ count: number }, []>("select count(*) as count from claims")
    .get();
  const evidences = db
    .query<
      { count: number },
      []
    >("select count(*) as count from claim_evidences")
    .get();
  const claimRevisions = db
    .query<{ count: number }, []>(
      "select count(*) as count from claim_revisions",
    )
    .get();
  expect(claims?.count).toBe(1);
  expect(evidences?.count).toBe(1);
  expect(claimRevisions?.count).toBe(1);
  const claim = db
    .query<
      { beforeText: string | null; afterText: string | null },
      []
    >("select beforeText, afterText from claims limit 1")
    .get();
  expect(claim?.beforeText).toBe("Project creation accepted any user input.");
  expect(claim?.afterText).toBe(
    "Project creation rejects missing users before returning data.",
  );
  const evidence = db
    .query<{ changeText: string | null }, []>(
      "select changeText from claim_evidences limit 1",
    )
    .get();
  expect(evidence?.changeText).toBe(
    "Throw when `createProject` receives a null user.",
  );
  db.close();

  writeFileSync(fixture.browserCapture, "");
  const reviewAgain = runPaire(fixture, ["review", "--open"]);
  expect(reviewAgain.exitCode).toBe(0);
  expect(reviewAgain.stdout).not.toContain("Action required");
  expect(reviewAgain.stdout).toContain("Open this URL in the browser:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );
});

test("apply rejects an out-of-range evidence span and accepts the corrected one", () => {
  const fixture = createFixtureRepo();

  runPaire(fixture, ["start", "--base", "main", "--goal", "Span validation"]);
  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) {",
      "    throw new Error('Unauthorized');",
      "  }",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add auth check");

  const review = runPaire(fixture, ["review"]);
  expect(review.exitCode).toBe(0);
  const packetPath = extractPacketPath(review.stdout);
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  expect(packet.touchedRanges).toBeTruthy();

  const result = hardcodedAgentResult(packet);
  result.threads[0]!.claims[0]!.evidences[0]!.startLine = 500;
  result.threads[0]!.claims[0]!.evidences[0]!.endLine = 505;
  const draftPath = join(fixture.root, "span-review-draft.json");
  writeFileSync(draftPath, JSON.stringify(result, null, 2));

  const rejected = runPaire(fixture, ["review", "--apply", draftPath]);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(rejected.stderr).toContain("evidence_out_of_range");
  expect(rejected.stderr).toContain("Changed line ranges in this file: 1-6");

  result.threads[0]!.claims[0]!.evidences[0]!.startLine = 1;
  result.threads[0]!.claims[0]!.evidences[0]!.endLine = 6;
  writeFileSync(draftPath, JSON.stringify(result, null, 2));
  const accepted = runPaire(fixture, ["review", "--apply", draftPath]);
  expect(accepted.exitCode).toBe(0);
});

test("real workflow smoke covers tracked, untracked, stale, apply, and reopen", () => {
  const fixture = createFixtureRepo();

  const start = runPaire(fixture, [
    "start",
    "--base",
    "main",
    "--goal",
    "Sandbox validation smoke test",
  ]);
  expect(start.exitCode).toBe(0);

  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null, name: string) {",
      "  if (!user) {",
      "    throw new Error('Unauthorized');",
      "  }",
      "  return { ownerId: user.id, name };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixture.repo, "src/workspace.ts"),
    [
      "export function validateWorkspace(input: { name?: string }) {",
      "  if (!input.name) {",
      "    throw new Error('Missing workspace name');",
      "  }",
      "  return input.name.trim();",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add auth and workspace validation");

  const firstReview = runPaire(fixture, ["review"]);
  expect(firstReview.exitCode).toBe(0);
  expect(firstReview.stdout).toContain("Action required");
  expect(existsSync(fixture.browserCapture)).toBe(false);
  const firstPacket = JSON.parse(
    readFileSync(extractPacketPath(firstReview.stdout), "utf8"),
  );
  expect(
    firstPacket.changedFiles.map((file: { path: string }) => file.path).sort(),
  ).toEqual(["src/app.ts", "src/workspace.ts"]);
  expect(JSON.stringify(firstPacket.touchedSnippets)).toContain(
    "validateWorkspace",
  );
  expect(firstPacket.touchedSnippets[0]?.text).toMatch(/\d+\|\+/);
  expect(firstPacket.touchedSnippets[0]?.changedLines).toBeUndefined();

  const firstResult = join(fixture.root, "sandbox-review-draft.json");
  writeFileSync(
    firstResult,
    JSON.stringify(sandboxAgentResult(firstPacket, "new"), null, 2),
  );
  const firstApply = runPaire(fixture, ["review", "--apply", firstResult, "--open"]);
  expect(firstApply.exitCode).toBe(0);
  expect(firstApply.stdout).toContain("Review burden: 2 new");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );

  const dbAfterFirstApply = new Database(join(fixture.home, "paire.db"));
  dbAfterFirstApply
    .prepare("update claims set humanStatus = 'accepted'")
    .run();
  dbAfterFirstApply.close();

  writeFileSync(fixture.browserCapture, "");
  const reopen = runPaire(fixture, ["review", "--open"]);
  expect(reopen.exitCode).toBe(0);
  expect(reopen.stdout).not.toContain("Action required");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );

  writeFileSync(
    join(fixture.repo, "src/workspace.ts"),
    [
      "export function validateWorkspace(input: { name?: string }) {",
      "  if (!input.name) {",
      "    throw new Error('Missing workspace name');",
      "  }",
      "  return input.name.trim();",
      "}",
      "",
      "export const workspaceValidationVersion = 2;",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add workspace validation version");
  writeFileSync(fixture.browserCapture, "");
  const staleReview = runPaire(fixture, ["review"]);
  expect(staleReview.exitCode).toBe(0);
  expect(staleReview.stdout).toContain("Action required");
  expect(readFileSync(fixture.browserCapture, "utf8")).toBe("");
  const secondPacket = JSON.parse(
    readFileSync(extractPacketPath(staleReview.stdout), "utf8"),
  );
  expect(
    secondPacket.changedFiles.map((file: { path: string }) => file.path),
  ).toEqual(["src/workspace.ts"]);
  expect(JSON.stringify(secondPacket.touchedSnippets)).toContain(
    "workspaceValidationVersion",
  );
  expect(secondPacket.touchedSnippets[0]?.addedRanges).toEqual([
    { startLine: 7, endLine: 8 },
  ]);
  expect(secondPacket.touchedSnippets[0]?.changedLines).toBeUndefined();
  expect(secondPacket.touchedSnippets[0]?.text).toContain(
    "8|+export const workspaceValidationVersion = 2;",
  );

  const secondResult = join(fixture.root, "sandbox-review-draft-2.json");
  writeFileSync(
    secondResult,
    JSON.stringify(
      sandboxAgentResult(secondPacket, "amended", {
        authThreadTitle: "The model tried to rewrite an unchanged area",
        authThreadSummary:
          "The model tried to rewrite a summary for an unchanged area.",
        authClaimTitle:
          "The model tried to rewrite an unchanged claim even though the status is unchanged.",
        authClaimDescription:
          "This rewritten description should also be ignored for unchanged claims.",
        authClaimBefore: "This rewritten before should be ignored.",
        authClaimAfter: "This rewritten after should be ignored.",
        minimalAuth: true,
      }),
      null,
      2,
    ),
  );
  const secondApply = runPaire(fixture, ["review", "--apply", secondResult]);
  expect(secondApply.exitCode).toBe(0);
  expect(secondApply.stdout).toContain("Review burden: 1 amended, 1 unchanged");

  const db = new Database(join(fixture.home, "paire.db"));
  const unchangedThread = db
    .query<{ title: string; summary: string }, []>(
      "select title, summary from change_threads where id like '%:thread_sandbox_auth'",
    )
    .get();
  const unchangedClaim = db
    .query<
      {
        title: string;
        description: string;
        beforeText: string | null;
        afterText: string | null;
      },
      []
    >(
      "select title, description, beforeText, afterText from claims where id like '%:claim_sandbox_auth_required'",
    )
    .get();
  expect(unchangedThread?.title).toBe("Auth validation");
  expect(unchangedThread?.summary).toBe(
    "Project creation rejects missing users before creating data.",
  );
  expect(unchangedClaim?.title).toBe("Reject missing users before create");
  expect(unchangedClaim?.description).toBe(
    "Project creation rejects missing users before returning project data.",
  );
  expect(unchangedClaim?.beforeText).toBe(
    "Project creation accepted any user input.",
  );
  expect(unchangedClaim?.afterText).toBe(
    "Project creation rejects missing users before returning data.",
  );
  const authHumanStatus = db
    .query<{ humanStatus: string }, []>(
      "select humanStatus from claims where id like '%:claim_sandbox_auth_required'",
    )
    .get();
  const workspaceHumanStatus = db
    .query<{ humanStatus: string }, []>(
      "select humanStatus from claims where id like '%:claim_sandbox_workspace_required'",
    )
    .get();
  expect(authHumanStatus?.humanStatus).toBe("accepted");
  expect(workspaceHumanStatus?.humanStatus).toBe("unreviewed");
  const authHistoryCount = db
    .query<{ count: number }, []>(
      "select count(*) as count from claim_revisions where claimId like '%:claim_sandbox_auth_required'",
    )
    .get();
  const workspaceHistoryCount = db
    .query<{ count: number }, []>(
      "select count(*) as count from claim_revisions where claimId like '%:claim_sandbox_workspace_required'",
    )
    .get();
  expect(authHistoryCount?.count).toBe(1);
  expect(workspaceHistoryCount?.count).toBe(2);
  db.close();
});

test("review API sorts threads and claims by importance", async () => {
  const fixture = createFixtureRepo();

  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) {",
      "    throw new Error('Unauthorized');",
      "  }",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add workspace validation");

  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "ordered-result.json");
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        packetId: packet.packetId,
        sessionId: packet.sessionId,
        revisionId: packet.revisionId,
        gitFingerprint: packet.currentFingerprint,
        files: draftFiles(packet),
        threads: [
          {
            id: "thread_older",
            title: "Older thread",
            summary: "First thread in apply order.",
            claims: [
              {
                id: "claim_older",
                threadId: "thread_older",
                title: "Older claim",
                description: "First claim in apply order.",
                before: "Before older.",
                after: "After older.",
                agentStatus: "new",
                importance: "minor",
                humanStatus: "unreviewed",
                evidences: [
                  {
                    filePath: "src/app.ts",
                    startLine: 1,
                    endLine: 6,
                    change: "Older claim evidence.",
                  },
                ],
              },
              {
                id: "claim_newer",
                threadId: "thread_older",
                title: "Newer claim",
                description: "Second claim in apply order.",
                before: "Before newer.",
                after: "After newer.",
                agentStatus: "new",
                importance: "important",
                humanStatus: "unreviewed",
                evidences: [
                  {
                    filePath: "src/app.ts",
                    startLine: 1,
                    endLine: 6,
                    change: "Newer claim evidence.",
                  },
                ],
              },
            ],
          },
          {
            id: "thread_newer",
            title: "Newer thread",
            summary: "Second thread in apply order.",
            claims: [
              {
                id: "claim_thread_newer",
                threadId: "thread_newer",
                title: "Newer thread claim",
                description: "Only claim in the newer thread.",
                before: "Before thread.",
                after: "After thread.",
                agentStatus: "new",
                importance: "minor",
                humanStatus: "unreviewed",
                evidences: [
                  {
                    filePath: "src/app.ts",
                    startLine: 1,
                    endLine: 6,
                    change: "Newer thread evidence.",
                  },
                ],
              },
            ],
          },
          {
            id: "thread_one_critical",
            title: "One critical thread",
            summary: "Thread with one critical claim.",
            claims: [
              {
                id: "claim_one_critical",
                threadId: "thread_one_critical",
                title: "One critical claim",
                description: "Only critical claim in this thread.",
                before: "Before one critical.",
                after: "After one critical.",
                agentStatus: "new",
                importance: "critical",
                humanStatus: "unreviewed",
                evidences: [
                  {
                    filePath: "src/app.ts",
                    startLine: 1,
                    endLine: 6,
                    change: "One critical evidence.",
                  },
                ],
              },
            ],
          },
          {
            id: "thread_more_critical",
            title: "More critical thread",
            summary: "Thread with two critical claims.",
            claims: [
              {
                id: "claim_more_critical_a",
                threadId: "thread_more_critical",
                title: "First critical claim",
                description: "First critical claim in this thread.",
                before: "Before first critical.",
                after: "After first critical.",
                agentStatus: "new",
                importance: "critical",
                humanStatus: "unreviewed",
                evidences: [
                  {
                    filePath: "src/app.ts",
                    startLine: 1,
                    endLine: 6,
                    change: "First critical evidence.",
                  },
                ],
              },
              {
                id: "claim_more_critical_b",
                threadId: "thread_more_critical",
                title: "Second critical claim",
                description: "Second critical claim in this thread.",
                before: "Before second critical.",
                after: "After second critical.",
                agentStatus: "new",
                importance: "critical",
                humanStatus: "unreviewed",
                evidences: [
                  {
                    filePath: "src/app.ts",
                    startLine: 1,
                    endLine: 6,
                    change: "Second critical evidence.",
                  },
                ],
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  expect(
    runPaire(fixture, ["review", "--apply", resultPath, "--no-open"]).exitCode,
  ).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const state = await waitForServerState(fixture.home, session!.id);
    const unauthenticated = await fetch(reviewApiUrl(state, "/api/review"));
    expect(unauthenticated.status).toBe(401);
    const reviewData = await reviewApiFetch(state, "/api/review").then((response) =>
      response.json(),
    );
    expect(reviewData.threads.map((thread: { id: string }) => thread.id)).toEqual([
      "thread_more_critical",
      "thread_one_critical",
      "thread_older",
      "thread_newer",
    ]);
    expect(
      reviewData.threads
        .find((thread: { id: string }) => thread.id === "thread_older")
        ?.claims.map((claim: { id: string }) => claim.id),
    ).toEqual(["claim_newer", "claim_older"]);
    expect(
      reviewData.threads
        .find((thread: { id: string }) => thread.id === "thread_older")
        ?.claims.find((claim: { id: string }) => claim.id === "claim_newer")
        ?.importance,
    ).toBe("important");
  } finally {
    runPaire(fixture, ["server", "stop"]);
  }
});

test("review API loads without embedding raw diffs and serves evidence diffs on demand", async () => {
  const fixture = createFixtureRepo();

  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) {",
      "    throw new Error('Unauthorized');",
      "  }",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add workspace validation");

  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "result.json");
  writeFileSync(
    resultPath,
    JSON.stringify(hardcodedAgentResult(packet), null, 2),
  );
  expect(
    runPaire(fixture, ["review", "--apply", resultPath, "--no-open"]).exitCode,
  ).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const state = await waitForServerState(fixture.home, session!.id);
    const reviewResponse = await reviewApiFetch(state, "/api/review");
    expect(reviewResponse.ok).toBe(true);
    const reviewText = await reviewResponse.text();
    expect(reviewText).not.toContain('"diff":"diff --git');
    const reviewData = JSON.parse(reviewText);
    const evidence = reviewData.threads[0].claims[0].evidences[0];
    expect(evidence.claimId).toBe("claim_auth_before_create");

    const reviewDiffResponse = await reviewApiFetch(state, "/api/review/diff");
    expect(reviewDiffResponse.ok).toBe(true);
    const reviewDiffPayload = await reviewDiffResponse.json();
    expect(reviewDiffPayload.diff).toContain(
      "diff --git a/src/app.ts b/src/app.ts",
    );
    expect(reviewDiffPayload.diff).toContain("throw new Error('Unauthorized')");

    const diffResponse = await reviewApiFetch(
      state,
      `/api/claims/${encodeURIComponent(evidence.claimId)}/evidence-diff?filePath=${encodeURIComponent(evidence.filePath)}`,
    );
    expect(diffResponse.ok).toBe(true);
    const diffPayload = await diffResponse.json();
    expect(diffPayload.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(diffPayload.diff).toContain("throw new Error('Unauthorized')");
  } finally {
    runPaire(fixture, ["server", "stop"]);
  }
});

test("dirty worktree opens review UI with a worktree review draft flow", () => {
  const fixture = createFixtureRepo();
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const start = runPaire(fixture, ["start", "--base", "main"]);
  expect(start.exitCode).toBe(0);

  const review = runPaire(fixture, ["review", "--open"]);
  expect(review.exitCode).toBe(0);
  expect(review.stdout).toContain("PAIRE_WORKTREE_REVIEW");
  expect(review.stdout).toContain(
    "Action required — update the Paire worktree review",
  );
  expect(review.stdout).toContain(
    "A working-tree preview was opened for the human at the URL below.",
  );
  expect(review.stdout).toContain("Step 3 — Apply");
  expect(review.stdout).toContain("paire worktree --apply");
  expect(review.stdout).toContain("worktree-review-draft.json");
  expect(review.stdout).toContain("Open this URL in the browser:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );
  expect(readFileSync(fixture.htmlCapture, "utf8")).toContain(
    'src="./main.tsx"',
  );

  // The draft is written to disk and carries the worktree identity header.
  const draftPath = extractWorktreeDraftPath(review.stdout);
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  expect(draft.worktreeReviewId).toMatch(/^wtr_/);
  expect(draft.worktreeHash).toMatch(/^[0-9a-f]{64}$/);
  expect(draft.gitHead).toMatch(/^[0-9a-f]{40}$/);
});

test("worktree diff API returns tracked and untracked changes", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  writeFileSync(
    join(fixture.repo, "src/new-file.ts"),
    "export const added = true;\n",
  );

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const state = await waitForServerState(fixture.home, session!.id);
    const unauthenticated = await fetch(reviewApiUrl(state, "/api/worktree/diff"));
    expect(unauthenticated.status).toBe(401);

    const dirtyResponse = await reviewApiFetch(state, "/api/worktree/diff");
    expect(dirtyResponse.ok).toBe(true);
    const dirtyPayload = await dirtyResponse.json();
    expect(dirtyPayload.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(dirtyPayload.diff).toContain("diff --git a/src/new-file.ts b/src/new-file.ts");
    expect(dirtyPayload.diff).toContain("export const value = 2;");
    expect(dirtyPayload.diff).toContain("export const added = true;");
    expect(dirtyPayload.skipped).toEqual([]);
    expect(dirtyPayload.files).toEqual(
      expect.arrayContaining([
        { path: "src/app.ts", additions: 1, deletions: 1 },
        { path: "src/new-file.ts", additions: 1, deletions: 0 },
      ]),
    );

    expect(dirtyPayload.worktreeHash).toMatch(/^[0-9a-f]{64}$/);

    commitAll(fixture.repo, "commit dirty worktree");
    const cleanPayload = await reviewApiFetch(state, "/api/worktree/diff").then(
      (response) => response.json(),
    );
    expect(cleanPayload.diff).toBe("");
    expect(cleanPayload.files).toEqual([]);
    expect(cleanPayload.skipped).toEqual([]);
    expect(cleanPayload.worktreeHash).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    runPaire(fixture, ["server", "stop"]);
  }
});

test("worktree diff API scopes concurrent sessions by token", async () => {
  const first = createFixtureRepo();
  const second = createFixtureRepo({ home: first.home });
  expect(runPaire(first, ["start", "--base", "main"]).exitCode).toBe(0);
  expect(runPaire(second, ["start", "--base", "main"]).exitCode).toBe(0);

  writeFileSync(join(first.repo, "src/app.ts"), "export const first = 1;\n");
  writeFileSync(join(second.repo, "src/app.ts"), "export const second = 2;\n");

  const firstSessionId = getOnlySessionId(first.home, first.repo);
  const secondSessionId = getOnlySessionId(first.home, second.repo);

  expect(runPaire(first, ["server", "start", "--no-open"]).exitCode).toBe(0);
  expect(runPaire(second, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const firstState = await waitForServerState(first.home, firstSessionId);
    const secondState = await waitForServerState(first.home, secondSessionId);

    const firstPayload = await reviewApiFetch(firstState, "/api/worktree/diff").then(
      (response) => response.json(),
    );
    const secondPayload = await reviewApiFetch(secondState, "/api/worktree/diff").then(
      (response) => response.json(),
    );

    expect(firstPayload.diff).toContain("export const first = 1;");
    expect(firstPayload.diff).not.toContain("export const second = 2;");
    expect(secondPayload.diff).toContain("export const second = 2;");
    expect(secondPayload.diff).not.toContain("export const first = 1;");
  } finally {
    runPaire(second, ["server", "stop"]);
    runPaire(first, ["server", "stop", "--all"]);
  }
});

test("dirty paire it creates then reuses a worktree draft for the current hash", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const first = runPaire(fixture, ["it"]);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toContain("PAIRE_WORKTREE_REVIEW");
  expect(first.stdout).toContain("paire worktree --apply");
  const firstPacket = JSON.parse(
    readFileSync(extractWorktreePacketPath(first.stdout), "utf8"),
  );

  // Re-running with the same dirty diff reuses the same worktree review row.
  const second = runPaire(fixture, ["it"]);
  expect(second.exitCode).toBe(0);
  const secondPacket = JSON.parse(
    readFileSync(extractWorktreePacketPath(second.stdout), "utf8"),
  );
  expect(secondPacket.worktreeReviewId).toBe(firstPacket.worktreeReviewId);
  expect(secondPacket.worktreeHash).toBe(firstPacket.worktreeHash);

  const db = new Database(join(fixture.home, "paire.db"));
  const rows = db
    .query<{ count: number }, []>(
      "select count(*) as count from worktree_reviews",
    )
    .get();
  expect(rows?.count).toBe(1);
  db.close();
});

test("paire worktree --apply stores claims without mutating committed tables", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  expect(it.exitCode).toBe(0);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "worktree-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));

  const apply = runPaire(fixture, ["worktree", "--apply", resultPath]);
  expect(apply.exitCode).toBe(0);
  expect(apply.stdout).toContain("Paire worktree review applied");
  expect(apply.stdout).toContain("Review burden: 1 new");

  const db = new Database(join(fixture.home, "paire.db"));
  const worktreeReview = db
    .query<{ state: string; payloadJson: string | null }, []>(
      "select state, payloadJson from worktree_reviews",
    )
    .get();
  expect(worktreeReview?.state).toBe("applied");
  expect(worktreeReview?.payloadJson).toContain("claim_worktree_value");
  // Committed review tables are untouched (only the start baseline revision).
  expect(
    db.query<{ count: number }, []>("select count(*) as count from claims").get()
      ?.count,
  ).toBe(0);
  expect(
    db
      .query<{ count: number }, []>(
        "select count(*) as count from change_threads",
      )
      .get()?.count,
  ).toBe(0);
  expect(
    db
      .query<{ count: number }, []>(
        "select count(*) as count from claim_evidences",
      )
      .get()?.count,
  ).toBe(0);
  expect(
    db
      .query<{ count: number }, []>(
        "select count(*) as count from revisions where state != 'applied' or number != 0",
      )
      .get()?.count,
  ).toBe(0);
  db.close();
});

test("changing the dirty diff changes the hash and rejects a stale worktree apply", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "stale-worktree-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));

  // Mutate the working tree so the current worktree hash no longer matches.
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 3;\n");
  const itAgain = runPaire(fixture, ["it"]);
  const nextPacket = JSON.parse(
    readFileSync(extractWorktreePacketPath(itAgain.stdout), "utf8"),
  );
  expect(nextPacket.worktreeHash).not.toBe(packet.worktreeHash);

  const apply = runPaire(fixture, ["worktree", "--apply", resultPath]);
  expect(apply.exitCode).not.toBe(0);
  expect(apply.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(apply.stderr).toContain('"code": "stale_worktree"');
});

test("re-running dirty paire it reloads applied worktree claims after daemon restart", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "reload-worktree-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));
  expect(runPaire(fixture, ["worktree", "--apply", resultPath]).exitCode).toBe(0);

  const sessionId = getOnlySessionId(fixture.home, fixture.repo);
  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const firstState = await waitForServerState(fixture.home, sessionId);
    const unauthenticated = await fetch(
      reviewApiUrl(firstState, "/api/worktree/review"),
    );
    expect(unauthenticated.status).toBe(401);
    const before = await reviewApiFetch(
      firstState,
      "/api/worktree/review",
    ).then((response) => response.json());
    expect(before.state).toBe("applied");
    expect(before.threads).toHaveLength(1);
    expect(before.threads[0].claims[0].id).toBe("claim_worktree_value");

    // Restart the daemon: claims must reload from disk for the same diff.
    runPaire(fixture, ["server", "stop", "--all"]);
    expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
    const secondState = await waitForServerState(fixture.home, sessionId);
    const after = await reviewApiFetch(
      secondState,
      "/api/worktree/review",
    ).then((response) => response.json());
    expect(after.state).toBe("applied");
    expect(after.threads).toHaveLength(1);
    expect(after.threads[0].claims[0].id).toBe("claim_worktree_value");
  } finally {
    runPaire(fixture, ["server", "stop", "--all"]);
  }
});

test("committing the worktree returns review to committed mode and leaves worktree claims dormant", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "dormant-worktree-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));
  expect(runPaire(fixture, ["worktree", "--apply", resultPath]).exitCode).toBe(0);

  commitAll(fixture.repo, "commit the worktree change");
  const review = runPaire(fixture, ["review"]);
  expect(review.exitCode).toBe(0);
  expect(review.stdout).toContain("Action required");
  expect(review.stdout).not.toContain("PAIRE_WORKTREE_REVIEW");

  // The worktree claims persist (dormant), not promoted into committed tables.
  const db = new Database(join(fixture.home, "paire.db"));
  expect(
    db
      .query<{ count: number }, []>(
        "select count(*) as count from worktree_reviews where state = 'applied'",
      )
      .get()?.count,
  ).toBe(1);
  expect(
    db.query<{ count: number }, []>("select count(*) as count from claims").get()
      ?.count,
  ).toBe(0);
  db.close();
});

test("worktree review API scopes concurrent sessions by token", async () => {
  const first = createFixtureRepo();
  const second = createFixtureRepo({ home: first.home });
  expect(runPaire(first, ["start", "--base", "main"]).exitCode).toBe(0);
  expect(runPaire(second, ["start", "--base", "main"]).exitCode).toBe(0);

  writeFileSync(join(first.repo, "src/app.ts"), "export const value = 2;\n");
  writeFileSync(join(second.repo, "src/app.ts"), "export const value = 9;\n");

  const firstIt = runPaire(first, ["it"]);
  const firstPacket = JSON.parse(
    readFileSync(extractWorktreePacketPath(firstIt.stdout), "utf8"),
  );
  const firstResult = join(first.root, "first-worktree-result.json");
  writeFileSync(
    firstResult,
    JSON.stringify(worktreeAgentResult(firstPacket), null, 2),
  );
  expect(runPaire(first, ["worktree", "--apply", firstResult]).exitCode).toBe(0);

  // The second session has a dirty tree but no applied worktree review.
  expect(runPaire(second, ["it"]).exitCode).toBe(0);

  const firstSessionId = getOnlySessionId(first.home, first.repo);
  const secondSessionId = getOnlySessionId(first.home, second.repo);

  expect(runPaire(first, ["server", "start", "--no-open"]).exitCode).toBe(0);
  expect(runPaire(second, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const firstState = await waitForServerState(first.home, firstSessionId);
    const secondState = await waitForServerState(first.home, secondSessionId);

    const firstReview = await reviewApiFetch(
      firstState,
      "/api/worktree/review",
    ).then((response) => response.json());
    const secondReview = await reviewApiFetch(
      secondState,
      "/api/worktree/review",
    ).then((response) => response.json());

    expect(firstReview.state).toBe("applied");
    expect(firstReview.threads).toHaveLength(1);
    expect(secondReview.state).toBe("pending_agent");
    expect(secondReview.threads).toHaveLength(0);
    expect(firstReview.worktreeHash).not.toBe(secondReview.worktreeHash);
  } finally {
    runPaire(second, ["server", "stop"]);
    runPaire(first, ["server", "stop", "--all"]);
  }
});

test("worktree human status updates persist for the current worktree hash", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "human-status-worktree-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));
  expect(runPaire(fixture, ["worktree", "--apply", resultPath]).exitCode).toBe(0);

  const sessionId = getOnlySessionId(fixture.home, fixture.repo);
  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const state = await waitForServerState(fixture.home, sessionId);
    const update = await fetch(
      reviewApiUrl(state, "/api/worktree/claims/claim_worktree_value/human-status"),
      {
        method: "POST",
        headers: {
          "x-paire-review-token": state.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ humanStatus: "accepted" }),
      },
    );
    expect(update.ok).toBe(true);

    const review = await reviewApiFetch(state, "/api/worktree/review").then(
      (response) => response.json(),
    );
    expect(review.threads[0].claims[0].humanStatus).toBe("accepted");
  } finally {
    runPaire(fixture, ["server", "stop", "--all"]);
  }
});

test("worktree review API keeps showing prior claims flagged stale when the diff changes", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "stale-show-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));
  expect(runPaire(fixture, ["worktree", "--apply", resultPath]).exitCode).toBe(0);

  // Move the working tree on so the applied review no longer matches the diff.
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 5;\n");

  const sessionId = getOnlySessionId(fixture.home, fixture.repo);
  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  try {
    const state = await waitForServerState(fixture.home, sessionId);
    const review = await reviewApiFetch(state, "/api/worktree/review").then(
      (response) => response.json(),
    );
    expect(review.stale).toBe(true);
    expect(review.threads).toHaveLength(1);
    expect(review.threads[0].claims[0].id).toBe("claim_worktree_value");
    expect(review.appliedHash).toBe(packet.worktreeHash);
    expect(review.appliedHash).not.toBe(review.worktreeHash);

    // Human status still persists against the stale (latest applied) review.
    const update = await fetch(
      reviewApiUrl(
        state,
        "/api/worktree/claims/claim_worktree_value/human-status",
      ),
      {
        method: "POST",
        headers: {
          "x-paire-review-token": state.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ humanStatus: "accepted" }),
      },
    );
    expect(update.ok).toBe(true);
    const after = await reviewApiFetch(state, "/api/worktree/review").then(
      (response) => response.json(),
    );
    expect(after.stale).toBe(true);
    expect(after.threads[0].claims[0].humanStatus).toBe("accepted");
  } finally {
    runPaire(fixture, ["server", "stop", "--all"]);
  }
});

test("dirty paire it after a diff change seeds the draft with prior claims to amend", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  const packet = JSON.parse(
    readFileSync(extractWorktreePacketPath(it.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "seed-amend-result.json");
  writeFileSync(resultPath, JSON.stringify(worktreeAgentResult(packet), null, 2));
  expect(runPaire(fixture, ["worktree", "--apply", resultPath]).exitCode).toBe(0);

  // Change the diff, regenerate: the new draft carries the prior claim as unchanged.
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 7;\n");
  const itAgain = runPaire(fixture, ["it"]);
  const draft = JSON.parse(
    readFileSync(extractWorktreeDraftPath(itAgain.stdout), "utf8"),
  );
  const claimIds = draft.threads.flatMap((thread: { claims: Array<{ id: string }> }) =>
    thread.claims.map((claim) => claim.id),
  );
  expect(claimIds).toContain("claim_worktree_value");
  expect(draft.threads[0].claims[0].agentStatus).toBe("unchanged");
});

test("sessions are scoped to the current git branch", () => {
  const fixture = createFixtureRepo();

  const mainStart = runPaire(fixture, [
    "start",
    "--base",
    "main",
    "--goal",
    "Main review",
  ]);
  expect(mainStart.exitCode).toBe(0);
  const mainSession = mainStart.stdout.match(/Session ID: (.+)/)?.[1];

  run(["git", "checkout", "-b", "feature"], fixture.repo);
  const featureStart = runPaire(fixture, [
    "start",
    "--base",
    "main",
    "--goal",
    "Feature review",
  ]);
  expect(featureStart.exitCode).toBe(0);
  const featureSession = featureStart.stdout.match(/Session ID: (.+)/)?.[1];
  expect(featureSession).toBeTruthy();
  expect(featureSession).not.toBe(mainSession);

  const featureRestart = runPaire(fixture, ["start", "--base", "main"]);
  expect(featureRestart.stdout).toContain(`Session ID: ${featureSession}`);

  run(["git", "checkout", "main"], fixture.repo);
  const mainStatus = runPaire(fixture, ["status"]);
  expect(mainStatus.stdout).toContain(`Session: ${mainSession}`);

  const db = new Database(join(fixture.home, "paire.db"));
  const sessions = db
    .query<{ branch: string }, []>("select branch from sessions order by branch")
    .all();
  expect(sessions.map((session) => session.branch)).toEqual([
    "feature",
    "main",
  ]);
  db.close();
});

test("paire it creates a branch session when missing", () => {
  const fixture = createFixtureRepo();

  const result = runPaire(fixture, ["it", "--base", "main"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Paire session ready.");
  expect(result.stdout).toContain("Open this URL in the browser:");

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db
    .query<{ branch: string }, []>("select branch from sessions")
    .get();
  expect(session?.branch).toBe("main");
  db.close();
});

test("reset clears review state on the current branch and re-baselines to baseCommit", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  run(["git", "checkout", "-b", "feature"], fixture.repo);
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const reset = runPaire(fixture, ["reset"]);
  expect(reset.exitCode).toBe(0);
  expect(reset.stdout).toContain("Reset Paire session for branch feature.");
  expect(reset.stdout).toContain("Review baseline set to");

  const featureStatus = runPaire(fixture, ["status"]);
  expect(featureStatus.stdout).toContain("Session:");
  expect(featureStatus.stdout).not.toContain("No Paire session found");

  run(["git", "checkout", "main"], fixture.repo);
  const mainStatus = runPaire(fixture, ["status"]);
  expect(mainStatus.stdout).toContain("Session:");

  const db = new Database(join(fixture.home, "paire.db"));
  const sessions = db
    .query<{ branch: string }, []>("select branch from sessions")
    .all();
  expect(sessions.map((session) => session.branch).sort()).toEqual([
    "feature",
    "main",
  ]);
  const featureClaims = db
    .query<{ count: number }, []>(
      "select count(*) as count from claims where sessionId in (select id from sessions where branch = 'feature')",
    )
    .get();
  expect(featureClaims?.count).toBe(0);
  db.close();
});

test("reset removes exported review draft, stale agent-result, and current-packet", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");

  const review = runPaire(fixture, ["review"]);
  const packetPath = extractPacketPath(review.stdout);
  const exportDir = dirname(packetPath);
  const agentResultPath = join(exportDir, "agent-result.json");
  const draftPath = join(exportDir, "review-draft.json");
  writeFileSync(agentResultPath, JSON.stringify({ stale: true }, null, 2));
  expect(existsSync(packetPath)).toBe(true);
  expect(existsSync(draftPath)).toBe(true);
  expect(existsSync(agentResultPath)).toBe(true);

  expect(runPaire(fixture, ["reset"]).exitCode).toBe(0);
  expect(existsSync(agentResultPath)).toBe(false);
  expect(existsSync(draftPath)).toBe(false);
  expect(existsSync(packetPath)).toBe(false);
});

test("reset re-baselines review so the next packet covers branch changes since baseCommit", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  run(["git", "checkout", "-b", "feature"], fixture.repo);
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/feature.ts"),
    "export const featureFlag = true;\n",
  );
  commitAll(fixture.repo, "add feature flag");

  const firstReview = runPaire(fixture, ["review"]);
  const firstPacket = JSON.parse(
    readFileSync(extractPacketPath(firstReview.stdout), "utf8"),
  );
  const firstResult = join(fixture.root, "first-result.json");
  writeFileSync(
    firstResult,
    JSON.stringify(hardcodedAgentResult(firstPacket), null, 2),
  );
  expect(
    runPaire(fixture, ["review", "--apply", firstResult, "--no-open"]).exitCode,
  ).toBe(0);

  const reset = runPaire(fixture, ["reset"]);
  expect(reset.exitCode).toBe(0);

  const review = runPaire(fixture, ["review"]);
  expect(review.stdout).toContain("Action required");
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  expect(
    packet.changedFiles.some(
      (file: { path: string }) => file.path === "src/feature.ts",
    ),
  ).toBe(true);
  const incrementalDiff = readFileSync(
    packet.incrementalDiffArtifactPath,
    "utf8",
  );
  expect(incrementalDiff).toContain("featureFlag");
});

test("start baselines new sessions at baseCommit so existing branch commits are reviewed", () => {
  const fixture = createFixtureRepo();
  run(["git", "checkout", "-b", "feature"], fixture.repo);
  writeFileSync(
    join(fixture.repo, "src/prestart-feature.ts"),
    "export const prestartFeature = true;\n",
  );
  commitAll(fixture.repo, "add prestart feature");

  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const review = runPaire(fixture, ["review"]);
  expect(review.stdout).toContain("Action required");
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  expect(packet.previousAppliedFingerprint).toBe(packet.baseCommit);
  expect(
    packet.changedFiles.some(
      (file: { path: string }) => file.path === "src/prestart-feature.ts",
    ),
  ).toBe(true);
  expect(readFileSync(packet.incrementalDiffArtifactPath, "utf8")).toContain(
    "prestartFeature",
  );
});

test("start baselines dirty new sessions at baseCommit instead of head", () => {
  const fixture = createFixtureRepo();
  run(["git", "checkout", "-b", "feature"], fixture.repo);
  writeFileSync(
    join(fixture.repo, "src/prestart-feature.ts"),
    "export const prestartFeature = true;\n",
  );
  commitAll(fixture.repo, "add prestart feature");
  writeFileSync(
    join(fixture.repo, "src/dirty-work.ts"),
    "export const dirtyWork = true;\n",
  );
  const head = gitOutput(["rev-parse", "HEAD"], fixture.repo);
  const baseCommit = gitOutput(["merge-base", "HEAD", "main"], fixture.repo);

  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const revision = db
    .query<{ gitFingerprint: string }, []>(
      "select gitFingerprint from revisions where number = 0 and state = 'applied'",
    )
    .get();
  db.close();
  expect(revision?.gitFingerprint).toBe(baseCommit);
  expect(revision?.gitFingerprint).not.toBe(head);
});

test("committed files that started untracked are included in review packets", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/new-workspace.ts"),
    [
      "export function validateWorkspace(input: { name?: string }) {",
      "  if (!input.name) throw new Error('Missing workspace name');",
      "  return input.name;",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add workspace validator");

  const review = runPaire(fixture, ["review"]);
  expect(review.stdout).toContain("Action required");
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const changedFile = packet.changedFiles.find(
    (file: { path: string }) => file.path === "src/new-workspace.ts",
  );
  expect(changedFile).toBeTruthy();
  expect(JSON.stringify(packet.touchedSnippets)).toContain("validateWorkspace");
  expect(readFileSync(packet.incrementalDiffArtifactPath, "utf8")).toContain(
    "new file mode 100644",
  );
});

test("project keys use a GitHub owner repo prefix with an isolated packet export", () => {
  const fixture = createFixtureRepo();
  run(
    ["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"],
    fixture.repo,
  );

  const start = runPaire(fixture, ["start", "--base", "main"]);
  expect(start.stdout).toContain("Project key: github/acme/widgets/");

  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 42;\n");
  commitAll(fixture.repo, "change value");

  const review = runPaire(fixture, ["review"]);
  const packetPath = extractPacketPath(review.stdout);
  expect(packetPath).toContain("/projects/github/acme/widgets/");
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  expect(packet.projectKey).toMatch(/^github\/acme\/widgets\//);
});

test("linked worktrees get distinct sessions and packet export directories", () => {
  const fixture = createFixtureRepo();
  const worktreeRepo = join(fixture.root, "feature-worktree");
  run(["git", "worktree", "add", "-b", "feature", worktreeRepo, "main"], fixture.repo);
  const worktreeFixture = { ...fixture, repo: worktreeRepo };

  const mainStart = runPaire(fixture, ["start", "--base", "main"]);
  const worktreeStart = runPaire(worktreeFixture, ["start", "--base", "main"]);
  expect(mainStart.exitCode).toBe(0);
  expect(worktreeStart.exitCode).toBe(0);

  const mainSession = mainStart.stdout.match(/Session ID: (.+)/)?.[1];
  const worktreeSession = worktreeStart.stdout.match(/Session ID: (.+)/)?.[1];
  const mainProjectKey = mainStart.stdout.match(/Project key: (.+)/)?.[1];
  const worktreeProjectKey = worktreeStart.stdout.match(/Project key: (.+)/)?.[1];
  expect(mainSession).toBeTruthy();
  expect(worktreeSession).toBeTruthy();
  expect(worktreeSession).not.toBe(mainSession);
  expect(mainProjectKey).toBeTruthy();
  expect(worktreeProjectKey).toBeTruthy();
  expect(worktreeProjectKey).not.toBe(mainProjectKey);

  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change main value");
  writeFileSync(
    join(worktreeRepo, "src/feature.ts"),
    "export const featureValue = 1;\n",
  );
  commitAll(worktreeRepo, "add feature value");

  const mainReview = runPaire(fixture, ["review"]);
  const worktreeReview = runPaire(worktreeFixture, ["review"]);
  expect(mainReview.exitCode).toBe(0);
  expect(worktreeReview.exitCode).toBe(0);
  const mainPacketPath = extractPacketPath(mainReview.stdout);
  const worktreePacketPath = extractPacketPath(worktreeReview.stdout);
  expect(dirname(mainPacketPath)).not.toBe(dirname(worktreePacketPath));

  const mainPacket = JSON.parse(readFileSync(mainPacketPath, "utf8"));
  const worktreePacket = JSON.parse(readFileSync(worktreePacketPath, "utf8"));
  expect(mainPacket.sessionId).toBe(mainSession);
  expect(worktreePacket.sessionId).toBe(worktreeSession);
  expect(mainPacket.projectKey).toBe(mainProjectKey);
  expect(worktreePacket.projectKey).toBe(worktreeProjectKey);

  const db = new Database(join(fixture.home, "paire.db"));
  const sessions = db
    .query<{ repoRoot: string; branch: string; projectKey: string }, []>(
      "select repoRoot, branch, projectKey from sessions order by repoRoot",
    )
    .all();
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map((session) => session.repoRoot)).size).toBe(2);
  expect(new Set(sessions.map((session) => session.projectKey)).size).toBe(2);
  expect(sessions.map((session) => session.branch).sort()).toEqual([
    "feature",
    "main",
  ]);
  db.close();
});

test("claim ids are scoped per session when repositories share PAIRE_HOME", () => {
  const first = createFixtureRepo();
  const second = createFixtureRepo();
  second.home = first.home;

  for (const fixture of [first, second]) {
    expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
    writeFileSync(
      join(fixture.repo, "src/app.ts"),
      "export const value = 2;\n",
    );
    commitAll(fixture.repo, "change value to two");

    const review = runPaire(fixture, ["review"]);
    const packet = JSON.parse(
      readFileSync(extractPacketPath(review.stdout), "utf8"),
    );
    const resultPath = join(fixture.root, "result.json");
    writeFileSync(
      resultPath,
      JSON.stringify(hardcodedAgentResult(packet), null, 2),
    );
    expect(
      runPaire(fixture, ["review", "--apply", resultPath, "--no-open"])
        .exitCode,
    ).toBe(0);
  }

  const db = new Database(join(first.home, "paire.db"));
  const sessions = db
    .query<{ id: string }, []>("select id from sessions order by createdAt")
    .all();
  expect(sessions).toHaveLength(2);
  for (const session of sessions) {
    const claims = db
      .query<{ count: number }, [string]>(
        "select count(*) as count from claims where sessionId = ?",
      )
      .get(session.id);
    expect(claims?.count).toBe(1);
  }
  const claimIds = db
    .query<{ id: string }, []>("select id from claims order by id")
    .all()
    .map((row) => row.id);
  expect(new Set(claimIds).size).toBe(2);
  expect(claimIds.every((id) => id.includes(":claim_auth_before_create"))).toBe(
    true,
  );
  db.close();
});

test("stale apply is rejected without mutating claims or opening browser", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");
  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const agentResultPath = join(fixture.root, "stale-result.json");
  writeFileSync(
    agentResultPath,
    JSON.stringify(hardcodedAgentResult(packet), null, 2),
  );

  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 3;\n");
  commitAll(fixture.repo, "change value to three");

  const apply = runPaire(fixture, ["review", "--apply", agentResultPath]);
  expect(apply.exitCode).not.toBe(0);
  expect(apply.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(apply.stderr).toContain('"code": "stale_fingerprint"');
  expect(existsSync(fixture.browserCapture)).toBe(false);

  const db = new Database(join(fixture.home, "paire.db"));
  const claims = db
    .query<{ count: number }, []>("select count(*) as count from claims")
    .get();
  expect(claims?.count).toBe(0);
  db.close();
});

test("apply rejects unsafe evidence paths and leaves review state unchanged", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");

  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const result = hardcodedAgentResult(packet);
  result.threads[0]!.claims[0]!.evidences[0]!.filePath = "../secrets.txt";
  const resultPath = join(fixture.root, "unsafe-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const apply = runPaire(fixture, ["review", "--apply", resultPath]);
  expect(apply.exitCode).not.toBe(0);
  expect(apply.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(apply.stderr).toContain('"field": "threads[0].claims[0].evidences[0].filePath"');

  const db = new Database(join(fixture.home, "paire.db"));
  const claims = db
    .query<{ count: number }, []>("select count(*) as count from claims")
    .get();
  expect(claims?.count).toBe(0);
  db.close();
});

test("apply rejects invalid claim importance and leaves review state unchanged", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");

  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const result = hardcodedAgentResult(packet);
  (result.threads[0]!.claims[0]! as { importance: string }).importance =
    "urgent";
  const resultPath = join(fixture.root, "invalid-importance-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const apply = runPaire(fixture, ["review", "--apply", resultPath]);
  expect(apply.exitCode).not.toBe(0);
  expect(apply.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(apply.stderr).toContain('"value": "urgent"');

  const db = new Database(join(fixture.home, "paire.db"));
  const claims = db
    .query<{ count: number }, []>("select count(*) as count from claims")
    .get();
  expect(claims?.count).toBe(0);
  db.close();
});

test("--check reports coverage errors without mutating review state", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) throw new Error('Unauthorized');",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixture.repo, "src/workspace.ts"),
    [
      "export function validateWorkspace(input: { name?: string }) {",
      "  if (!input.name) throw new Error('Missing workspace name');",
      "  return input.name;",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add auth and workspace validation");

  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const result = sandboxAgentResult(packet, "new");
  const thread = result.threads.find(
    (candidate) => candidate.id === "thread_sandbox_workspace",
  );
  if (!thread) throw new Error("Expected sandbox workspace thread.");
  thread.claims = [];
  const resultPath = join(fixture.root, "missing-coverage-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const check = runPaire(fixture, ["review", "--check", resultPath]);
  expect(check.exitCode).toBe(1);
  expect(check.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(check.stderr).toContain('"code": "file_not_covered"');
  expect(check.stderr).toContain('"path": "src/workspace.ts"');

  const db = new Database(join(fixture.home, "paire.db"));
  const claims = db
    .query<{ count: number }, []>("select count(*) as count from claims")
    .get();
  expect(claims?.count).toBe(0);
  db.close();
});

test("--check and --apply reject title-bearing evidence_moved prior claims without full copy", () => {
  const fixture = createFixtureRepo();
  const packet = createSecondSandboxReviewPacket(fixture);
  const result = sandboxAgentResult(packet, "amended", { minimalAuth: true });
  const authClaim = result.threads[0]!.claims[0]! as Record<string, unknown>;
  authClaim.agentStatus = "evidence_moved";
  authClaim.title = "Moved auth validation evidence";
  authClaim.evidences = [
    {
      filePath: "src/app.ts",
      startLine: 1,
      endLine: 6,
      symbol: "createProject",
      change: "Auth validation moved to a nearby location.",
    },
  ];
  const resultPath = join(fixture.root, "bad-evidence-moved-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const check = runPaire(fixture, ["review", "--check", resultPath]);
  expect(check.exitCode).toBe(1);
  expect(check.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(check.stderr).toContain('"field": "threads[0].claims[0].importance"');
  expect(check.stderr).toContain('"field": "threads[0].claims[0].before"');
  expect(check.stderr).toContain('"field": "threads[0].claims[0].after"');
  expect(check.stderr).not.toContain('"code": "missing_prior_claim"');

  const apply = runPaire(fixture, ["review", "--apply", resultPath]);
  expect(apply.exitCode).toBe(1);
  expect(apply.stderr).toContain("PAIRE_APPLY_REJECTED");
  expect(apply.stderr).toContain('"field": "threads[0].claims[0].importance"');
  expect(apply.stderr).not.toContain("Validated claim");
});

test("apply accepts minimal invalidated prior claims and preserves stored copy", () => {
  const fixture = createFixtureRepo();
  const packet = createSecondSandboxReviewPacket(fixture);
  const result = sandboxAgentResult(packet, "amended", { minimalAuth: true });
  const authClaim = result.threads[0]!.claims[0]! as Record<string, unknown>;
  authClaim.agentStatus = "invalidated";
  const resultPath = join(fixture.root, "minimal-invalidated-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const apply = runPaire(fixture, ["review", "--apply", resultPath]);
  expect(apply.exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const claim = db
    .query<
      {
        title: string;
        importance: string;
        beforeText: string | null;
        afterText: string | null;
        agentStatus: string;
      },
      []
    >(
      "select title, importance, beforeText, afterText, agentStatus from claims where id like '%:claim_sandbox_auth_required'",
    )
    .get();
  expect(claim?.agentStatus).toBe("invalidated");
  expect(claim?.title).toBe("Reject missing users before create");
  expect(claim?.importance).toBe("minor");
  expect(claim?.beforeText).toBe("Project creation accepted any user input.");
  expect(claim?.afterText).toBe(
    "Project creation rejects missing users before returning data.",
  );
  const evidence = db
    .query<{ count: number }, []>(
      "select count(*) as count from claim_evidences where claimId like '%:claim_sandbox_auth_required'",
    )
    .get();
  expect(evidence?.count).toBe(1);
  db.close();
});

test("new git changes after apply require a fresh packet and do not open browser", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");
  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const resultPath = join(fixture.root, "result.json");
  writeFileSync(
    resultPath,
    JSON.stringify(hardcodedAgentResult(packet), null, 2),
  );
  expect(runPaire(fixture, ["review", "--apply", resultPath]).exitCode).toBe(0);

  writeFileSync(fixture.browserCapture, "");
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 4;\n");
  commitAll(fixture.repo, "change value to four");
  const staleReview = runPaire(fixture, ["review"]);
  expect(staleReview.stdout).toContain("Action required");
  expect(readFileSync(fixture.browserCapture, "utf8")).toBe("");
});

test("version command reports dev when running from source", () => {
  const fixture = createFixtureRepo();
  const version = runPaire(fixture, ["--version"]);

  expect(version.exitCode).toBe(0);
  expect(version.stdout.trim()).toBe("dev");
});

test("incremental packet after an applied commit only includes changes since the last Paire apply", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) return null;",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "make create project nullable");
  const firstReview = runPaire(fixture, ["review"]);
  const firstPacket = JSON.parse(
    readFileSync(extractPacketPath(firstReview.stdout), "utf8"),
  );
  const firstResult = join(fixture.root, "first-result.json");
  writeFileSync(
    firstResult,
    JSON.stringify(hardcodedAgentResult(firstPacket), null, 2),
  );
  expect(
    runPaire(fixture, ["review", "--apply", firstResult, "--no-open"]).exitCode,
  ).toBe(0);

  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) {",
      "    throw new Error('Unauthorized');",
      "  }",
      "  return { ownerId: user.id, audited: true };",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "audit create project");
  const secondReview = runPaire(fixture, ["review"]);
  const secondPacket = JSON.parse(
    readFileSync(extractPacketPath(secondReview.stdout), "utf8"),
  );
  expect(
    secondPacket.changedFiles.some(
      (file: { path: string }) => file.path === "src/app.ts",
    ),
  ).toBe(true);
  const incrementalDiff = readFileSync(
    secondPacket.incrementalDiffArtifactPath,
    "utf8",
  );

  expect(incrementalDiff).toContain("audited: true");
  expect(incrementalDiff).toContain("throw new Error");
  expect(incrementalDiff).not.toContain("export const value = 1");
});

test("oversized lockfile diffs are summarized with safe inspection commands", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "package-lock.json"),
    JSON.stringify(
      { lockfileVersion: 3, packages: makeLargeLockPackages() },
      null,
      2,
    ),
  );
  commitAll(fixture.repo, "update lockfile");
  const review = runPaire(fixture, ["review"]);
  const packet = JSON.parse(
    readFileSync(extractPacketPath(review.stdout), "utf8"),
  );
  const lockFile = packet.changedFiles.find(
    (file: { path: string }) => file.path === "package-lock.json",
  );

  expect(lockFile.summarized).toBe(true);
  expect(packet.safeInspectionCommands.join("\n")).toContain(
    "git diff --unified=40 -- 'package-lock.json'",
  );
  expect(JSON.stringify(packet.touchedSnippets)).not.toContain("package-499");
});

test("paire install appends agent instructions to AGENTS.md and CLAUDE.md", () => {
  const fixture = createFixtureRepo();
  const agentsPath = join(fixture.repo, "AGENTS.md");
  const claudePath = join(fixture.repo, "CLAUDE.md");
  writeFileSync(agentsPath, "# Agent rules\n");
  writeFileSync(claudePath, "---\ndescription: test\n---\n\n# Claude\n");

  const first = runPaire(fixture, ["install"]);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toContain("Updated: AGENTS.md, CLAUDE.md");

  const agents = readFileSync(agentsPath, "utf8");
  const claude = readFileSync(claudePath, "utf8");
  expect(agents).toContain("<!-- paire -->");
  expect(agents).toContain("<!-- /paire -->");
  expect(agents).toContain("`paire it` is a command");
  expect(agents).toContain("paire review --apply");
  expect(claude).toContain("<!-- paire -->");
  expect(claude).toContain("`paire it` is a command");

  const second = runPaire(fixture, ["install"]);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain("Already up to date: AGENTS.md, CLAUDE.md");
  expect(readFileSync(agentsPath, "utf8")).toBe(agents);
});

test("paire install replaces an existing Paire block in place", () => {
  const fixture = createFixtureRepo();
  const agentsPath = join(fixture.repo, "AGENTS.md");
  // A drifted/legacy block, with content both before and after it.
  writeFileSync(
    agentsPath,
    [
      "# Agent rules",
      "",
      "<!-- paire -->",
      "## Paire",
      "",
      "Old, out-of-date instructions that should be replaced.",
      "<!--/ paire -->",
      "",
      "## Keep me",
      "Trailing content must survive.",
      "",
    ].join("\n"),
  );

  const result = runPaire(fixture, ["install"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Updated: AGENTS.md");

  const agents = readFileSync(agentsPath, "utf8");
  // Old content gone, new content in, no duplicate block, surrounding text kept.
  expect(agents).not.toContain("Old, out-of-date instructions");
  expect(agents).toContain("`paire it` is a command");
  expect(agents.match(/<!-- paire -->/g)?.length).toBe(1);
  expect(agents).toContain("# Agent rules");
  expect(agents).toContain("## Keep me");
  expect(agents).toContain("Trailing content must survive.");

  // Idempotent once current.
  const again = runPaire(fixture, ["install"]);
  expect(again.stdout).toContain("Already up to date: AGENTS.md");
  expect(readFileSync(agentsPath, "utf8")).toBe(agents);
});

test("paire install upgrades a legacy block with no closing marker", () => {
  const fixture = createFixtureRepo();
  const agentsPath = join(fixture.repo, "AGENTS.md");
  writeFileSync(
    agentsPath,
    [
      "# Agent rules",
      "",
      "<!-- paire -->",
      "## Paire",
      "",
      "When you **git push**, run `paire it`.",
      "",
    ].join("\n"),
  );

  const result = runPaire(fixture, ["install"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Updated: AGENTS.md");

  const agents = readFileSync(agentsPath, "utf8");
  expect(agents).not.toContain("When you **git push**, run `paire it`.");
  expect(agents).toContain("`paire it` is a command");
  expect(agents).toContain("<!-- /paire -->");
  expect(agents.match(/<!-- paire -->/g)?.length).toBe(1);
  expect(agents).toContain("# Agent rules");
});

test("paire install skips missing agent instruction files", () => {
  const fixture = createFixtureRepo();
  writeFileSync(join(fixture.repo, "AGENTS.md"), "# Agent rules\n");

  const result = runPaire(fixture, ["install"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Updated: AGENTS.md");
  expect(result.stdout).toContain("Not found (skipped): CLAUDE.md");
});

test("paire install works in a git repo before the first commit", () => {
  const fixture = createUncommittedFixtureRepo();
  writeFileSync(join(fixture.repo, "AGENTS.md"), "# Agent rules\n");

  const result = runPaire(fixture, ["install"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Updated: AGENTS.md");
  expect(readFileSync(join(fixture.repo, "AGENTS.md"), "utf8")).toContain(
    "<!-- paire -->",
  );
});

test("it aliases review and status/sync avoid push or commit suggestions", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");

  const it = runPaire(fixture, ["it"]);
  expect(it.stdout).toContain("Action required");

  const status = runPaire(fixture, ["status"]);
  expect(status.stdout).toContain("Paire status");
  expect(status.stdout).not.toContain("git push");
  expect(status.stdout).not.toContain("git commit");

  const sync = runPaire(fixture, ["sync"]);
  expect(sync.stdout).toContain("Cloud sync is not configured");
  expect(sync.stdout).not.toContain("git push");
  expect(sync.stdout).not.toContain("git commit");
});

test("paire server start spawns or reuses the review UI server", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  // Default does not open a browser, but still prints the URL.
  writeFileSync(fixture.browserCapture, "");
  const start = runPaire(fixture, ["server", "start"]);
  expect(start.exitCode).toBe(0);
  expect(start.stdout).toContain("Review UI:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toBe("");

  const state = await waitForServerState(fixture.home, session!.id);
  expect(state.port).toBe(PREFERRED_REVIEW_PORT);
  expect(state.url).toContain(`http://127.0.0.1:${PREFERRED_REVIEW_PORT}/`);
  expect(await reviewApiFetch(state, "/api/review").then((r) => r.ok)).toBe(true);

  // --open launches the browser.
  writeFileSync(fixture.browserCapture, "");
  const startOpen = runPaire(fixture, ["server", "start", "--open"]);
  expect(startOpen.exitCode).toBe(0);
  expect(startOpen.stdout).toContain(state.url);
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(state.url);

  const stop = runPaire(fixture, ["server", "stop"]);
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout).toContain("Stopped the review UI server.");
});

test("paire server start falls back to an open port when the preferred port is occupied", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  const occupyingServer = Bun.serve({
    hostname: "127.0.0.1",
    port: PREFERRED_REVIEW_PORT,
    fetch: () => new Response("occupied"),
  });
  try {
    const start = runPaire(fixture, ["server", "start", "--no-open"]);
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain("Review UI:");

    const state = await waitForServerState(fixture.home, session!.id);
    expect(state.port).toBeGreaterThan(PREFERRED_REVIEW_PORT);
    expect(await reviewApiFetch(state, "/api/review").then((r) => r.ok)).toBe(true);

    const stop = runPaire(fixture, ["server", "stop"]);
    expect(stop.exitCode).toBe(0);
  } finally {
    occupyingServer.stop();
  }
});

test("paire server stop shuts down the review UI server for the current branch", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  const start = runPaire(fixture, ["server", "start", "--no-open"]);
  expect(start.exitCode).toBe(0);

  const state = await waitForServerState(fixture.home, session!.id);
  expect(await reviewApiFetch(state, "/api/review").then((r) => r.ok)).toBe(true);

  const daemonStatePath = join(fixture.home, "review-server.json");
  expect(existsSync(daemonStatePath)).toBe(true);
  const daemonPid = JSON.parse(readFileSync(daemonStatePath, "utf8")).pid as number;

  const stop = runPaire(fixture, ["server", "stop"]);
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout).toContain("Stopped the review UI server.");
  expect(
    existsSync(join(fixture.home, "review-servers", `${session!.id}.json`)),
  ).toBe(false);

  // The last session unregistered, so the shared daemon shuts itself down.
  await waitForProcessExit(daemonPid);
  expect(existsSync(daemonStatePath)).toBe(false);

  const stopAgain = runPaire(fixture, ["server", "stop"]);
  expect(stopAgain.exitCode).toBe(0);
  expect(stopAgain.stdout).toContain("No review UI server is running for this branch.");
});

test("paire server stop leaves the shared server up for other branches; --all stops it", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  // Second branch with its own Paire session, sharing the same daemon.
  run(["git", "checkout", "-b", "feature"], fixture.repo);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 3;\n");
  commitAll(fixture.repo, "feature change");
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  // Bring up the shared server for both branches.
  run(["git", "checkout", "main"], fixture.repo);
  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  run(["git", "checkout", "feature"], fixture.repo);
  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);

  const daemonStatePath = join(fixture.home, "review-server.json");
  expect(existsSync(daemonStatePath)).toBe(true);
  const daemonPid = JSON.parse(readFileSync(daemonStatePath, "utf8")).pid as number;

  // Stopping one branch keeps the shared server running for the other.
  const stopOne = runPaire(fixture, ["server", "stop"]);
  expect(stopOne.exitCode).toBe(0);
  expect(stopOne.stdout).toContain("Stopped the review UI for feature");
  expect(stopOne.stdout).toContain("1 other branch");
  expect(stopOne.stdout).toContain("paire server stop --all");
  expect(existsSync(daemonStatePath)).toBe(true);
  try {
    process.kill(daemonPid, 0);
  } catch {
    throw new Error("Shared server should still be running after one branch stop.");
  }

  // --all tears the whole thing down and clears every branch's state.
  const stopAll = runPaire(fixture, ["server", "stop", "--all"]);
  expect(stopAll.exitCode).toBe(0);
  expect(stopAll.stdout).toContain("Stopped the shared review server.");
  await waitForProcessExit(daemonPid);
  expect(existsSync(daemonStatePath)).toBe(false);
  expect(existsSync(join(fixture.home, "review-servers"))).toBe(true);
  expect(readdirSync(join(fixture.home, "review-servers")).length).toBe(0);
});

test("paire server stop removes stale review server state", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  const statePath = join(fixture.home, "review-servers", `${session!.id}.json`);
  writeFileSync(
    statePath,
    JSON.stringify({
      pid: 2_147_483_647,
      port: 59999,
      url: "http://127.0.0.1:59999/",
      token: "stale-token",
      sessionId: session!.id,
      repoRoot: fixture.repo,
      startedAt: Date.now(),
    }),
  );

  const stop = runPaire(fixture, ["server", "stop"]);
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout).toContain("Review UI server was not running. Removed stale state.");
  expect(existsSync(statePath)).toBe(false);
});

test("paire server stop does not kill unrelated process when PID was reused", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  const sleeper = Bun.spawn(["sleep", "300"], { stdout: "ignore" });
  try {
    const statePath = join(fixture.home, "review-servers", `${session!.id}.json`);
    writeFileSync(
      statePath,
      JSON.stringify({
        pid: sleeper.pid,
        port: 59999,
        url: "http://127.0.0.1:59999/",
        token: "stale-token",
        sessionId: session!.id,
        repoRoot: fixture.repo,
        startedAt: Date.now(),
      }),
    );

    const stop = runPaire(fixture, ["server", "stop"]);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("Review UI server was not running. Removed stale state.");
    expect(existsSync(statePath)).toBe(false);
    expect(sleeper.exitCode).toBe(null);
  } finally {
    sleeper.kill();
    await sleeper.exited;
  }
});

test("compiled binary spawns review server without script path", async () => {
  const fixture = createFixtureRepo();
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const binary = join(fixture.root, "paire-bin");
  const build = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../scripts/build.ts"),
      `--outfile=${binary}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode).toBe(0);

  const env = {
    ...process.env,
    PAIRE_HOME: fixture.home,
  };

  expect(
    Bun.spawnSync([binary, "start", "--base", "main"], {
      cwd: fixture.repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode,
  ).toBe(0);

  const review = Bun.spawnSync([binary, "review"], {
    cwd: fixture.repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(review.exitCode).toBe(0);
  expect(text(review.stdout)).toContain("PAIRE_WORKTREE_REVIEW");
  expect(text(review.stdout)).toContain("Open this URL in the browser:");

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  const state = await waitForServerState(fixture.home, session!.id);
  const reviewResponse = await reviewApiFetch(state, "/api/review");
  expect(reviewResponse.ok).toBe(true);

  if (state.pid) {
    try {
      process.kill(state.pid);
    } catch {
      // already exited
    }
  }
});

test("compiled binary supports status in a fixture repo", () => {
  const fixture = createFixtureRepo();
  const binary = join(fixture.root, "paire-bin");
  const build = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../scripts/build.ts"),
      `--outfile=${binary}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode).toBe(0);
  expect(text(build.stderr)).not.toContain("invalid @ rule");

  const result = Bun.spawnSync([binary, "status"], {
    cwd: fixture.repo,
    env: testEnv(fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(text(result.stdout)).toContain("No Paire session found");
});

test("compiled binary embeds the build version", () => {
  const fixture = createFixtureRepo();
  const binary = join(fixture.root, "paire-bin");
  const build = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../scripts/build.ts"),
      `--outfile=${binary}`,
      "--version=v9.8.7",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode).toBe(0);

  const result = Bun.spawnSync([binary, "--version"], {
    cwd: fixture.repo,
    env: testEnv(fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(text(result.stdout).trim()).toBe("v9.8.7");
});

function createUncommittedFixtureRepo(options: { home?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paire-cli-"));
  const repo = join(root, "repo");
  const home = options.home ?? join(root, "home");
  const browserCapture = join(root, "browser.txt");
  const htmlCapture = join(root, "review.html");
  run(["git", "init", "-b", "main", repo], root);
  const fixture = { root, repo, home, browserCapture, htmlCapture };
  fixtures.push(fixture);
  return fixture;
}

function createFixtureRepo(options: { home?: string } = {}): Fixture {
  const fixture = createUncommittedFixtureRepo(options);
  const { repo } = fixture;
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  run(["mkdir", "-p", "src"], repo);
  writeFileSync(join(repo, "src/app.ts"), "export const value = 1;\n");
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", "initial"], repo);
  return fixture;
}

function runPaire(fixture: Fixture, args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
    {
      cwd: fixture.repo,
      env: testEnv(fixture),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
  };
}

function testEnv(fixture: Fixture) {
  return {
    ...process.env,
    PAIRE_HOME: fixture.home,
    PAIRE_BROWSER_CAPTURE: fixture.browserCapture,
    PAIRE_BROWSER_HTML_CAPTURE: fixture.htmlCapture,
  };
}

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${text(result.stderr)}`);
  }
}

function gitOutput(args: string[], cwd: string) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${text(result.stderr)}`);
  }
  return text(result.stdout).trim();
}

function commitAll(repo: string, message: string) {
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", message], repo);
}

function getOnlySessionId(home: string, repoRoot: string) {
  const canonicalRepoRoot = gitOutput(["rev-parse", "--show-toplevel"], repoRoot);
  const db = new Database(join(home, "paire.db"));
  const session = db
    .query<{ id: string }, [string]>("select id from sessions where repoRoot = ?")
    .get(canonicalRepoRoot);
  db.close();
  if (!session?.id) throw new Error(`No session found for ${canonicalRepoRoot}`);
  return session.id;
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}

function extractPacketPath(stdout: string) {
  const draftPath = extractDraftPath(stdout);
  return join(dirname(draftPath), "current-packet.json");
}

function extractDraftPath(stdout: string) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("/") &&
      trimmed.endsWith("review-draft.json") &&
      !trimmed.includes("--apply")
    ) {
      return trimmed;
    }
  }
  throw new Error(`Draft path missing from output:\n${stdout}`);
}

function extractWorktreePacketPath(stdout: string) {
  return join(dirname(extractWorktreeDraftPath(stdout)), "worktree-packet.json");
}

function worktreeAgentResult(packet: {
  packetId: string;
  sessionId: string;
  worktreeReviewId: string;
  worktreeHash: string;
  gitHead: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
}) {
  const primaryFilePath = packet.changedFiles.some(
    (file) => file.path === "src/app.ts",
  )
    ? "src/app.ts"
    : packet.changedFiles[0]?.path;
  if (!primaryFilePath) throw new Error("Worktree packet has no changed files.");
  return {
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    worktreeReviewId: packet.worktreeReviewId,
    worktreeHash: packet.worktreeHash,
    gitHead: packet.gitHead,
    files: packet.changedFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      disposition: "pending",
    })),
    threads: [
      {
        id: "thread_worktree",
        title: "Worktree changes",
        summary: "Working-tree edits under review.",
        claims: [
          {
            id: "claim_worktree_value",
            threadId: "thread_worktree",
            title: "Adjust exported value",
            description: "Updates the exported constant in the working tree.",
            before: "Exported value was the prior constant.",
            after: "Exported value is the new constant.",
            agentStatus: "new",
            importance: "minor",
            humanStatus: "unreviewed",
            evidences: [
              {
                filePath: primaryFilePath,
                startLine: 1,
                endLine: 1,
                change: "Change the exported value in the working tree.",
              },
            ],
          },
        ],
      },
    ],
  };
}

function extractWorktreeDraftPath(stdout: string) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("/") &&
      trimmed.endsWith("worktree-review-draft.json") &&
      !trimmed.includes("--apply")
    ) {
      return trimmed;
    }
  }
  throw new Error(`Worktree draft path missing from output:\n${stdout}`);
}

function createSecondSandboxReviewPacket(fixture: Fixture) {
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repo, "src/app.ts"),
    [
      "export function createProject(user: { id: string } | null) {",
      "  if (!user) throw new Error('Unauthorized');",
      "  return { ownerId: user.id };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixture.repo, "src/workspace.ts"),
    [
      "export function validateWorkspace(input: { name?: string }) {",
      "  if (!input.name) throw new Error('Missing workspace name');",
      "  return input.name;",
      "}",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add auth and workspace validation");

  const firstReview = runPaire(fixture, ["review"]);
  expect(firstReview.exitCode).toBe(0);
  const firstPacket = JSON.parse(
    readFileSync(extractPacketPath(firstReview.stdout), "utf8"),
  );
  const firstResultPath = join(fixture.root, "initial-sandbox-result.json");
  writeFileSync(
    firstResultPath,
    JSON.stringify(sandboxAgentResult(firstPacket, "new"), null, 2),
  );
  const firstApply = runPaire(fixture, ["review", "--apply", firstResultPath]);
  expect(firstApply.exitCode).toBe(0);

  writeFileSync(
    join(fixture.repo, "src/workspace.ts"),
    [
      "export function validateWorkspace(input: { name?: string }) {",
      "  if (!input.name) {",
      "    throw new Error('Missing workspace name');",
      "  }",
      "  return input.name.trim();",
      "}",
      "",
      "export const workspaceValidationVersion = 2;",
      "",
    ].join("\n"),
  );
  commitAll(fixture.repo, "add workspace validation version");

  const secondReview = runPaire(fixture, ["review"]);
  expect(secondReview.exitCode).toBe(0);
  return JSON.parse(readFileSync(extractPacketPath(secondReview.stdout), "utf8"));
}

async function waitForServerState(home: string, sessionId: string) {
  const path = join(home, "review-servers", `${sessionId}.json`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as {
        url: string;
        token: string;
        port: number;
        pid?: number;
      };
    }
    await Bun.sleep(50);
  }
  throw new Error("Review server did not start.");
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error("Process did not exit.");
}

function reviewApiUrl(state: { url: string }, path: string) {
  return new URL(path, state.url).toString();
}

function reviewApiFetch(state: { url: string; token: string }, path: string) {
  return fetch(reviewApiUrl(state, path), {
    headers: { "x-paire-review-token": state.token },
  });
}

function hardcodedAgentResult(packet: {
  packetId: string;
  sessionId: string;
  revisionId: string;
  currentFingerprint: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
}) {
  const primaryFilePath = packet.changedFiles.some((file) => file.path === "src/app.ts")
    ? "src/app.ts"
    : packet.changedFiles[0]?.path;
  if (!primaryFilePath) throw new Error("Packet has no changed files.");
  return {
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    revisionId: packet.revisionId,
    gitFingerprint: packet.currentFingerprint,
    files: draftFiles(packet),
    threads: [
      {
        id: "thread_workspace_validation",
        title: "Workspace validation",
        summary:
          "Project creation now rejects missing users before creating data.",
        claims: [
          {
            id: "claim_auth_before_create",
            threadId: "thread_workspace_validation",
            title: "Reject missing users before create",
            description:
              "Project creation rejects missing users before returning project data.",
            before: "Project creation accepted any user input.",
            after:
              "Project creation rejects missing users before returning data.",
            agentStatus: "new",
            importance: "minor",
            humanStatus: "unreviewed",
            evidences: [
              {
                filePath: primaryFilePath,
                startLine: 1,
                endLine: 6,
                symbol: "createProject",
                change: "Throw when `createProject` receives a null user.",
              },
            ],
          },
        ],
      },
    ],
  };
}

function sandboxAgentResult(
  packet: {
    packetId: string;
    sessionId: string;
    revisionId: string;
    currentFingerprint: string;
    changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  },
  workspaceStatus: "new" | "amended",
  overrides: {
    authThreadTitle?: string;
    authThreadSummary?: string;
    authClaimTitle?: string;
    authClaimDescription?: string;
    authClaimBefore?: string;
    authClaimAfter?: string;
    minimalAuth?: boolean;
  } = {},
) {
  const authClaim = overrides.minimalAuth
    ? {
        id: "claim_sandbox_auth_required",
        agentStatus: "unchanged",
      }
    : {
        id: "claim_sandbox_auth_required",
        threadId: "thread_sandbox_auth",
        title:
          overrides.authClaimTitle ?? "Reject missing users before create",
        description:
          overrides.authClaimDescription ??
          "Project creation rejects missing users before returning project data.",
        before:
          overrides.authClaimBefore ??
          "Project creation accepted any user input.",
        after:
          overrides.authClaimAfter ??
          "Project creation rejects missing users before returning data.",
        agentStatus: workspaceStatus === "new" ? "new" : "unchanged",
        importance: "minor",
        humanStatus: "unreviewed",
        evidences: [
          {
            filePath: "src/app.ts",
            startLine: 1,
            endLine: 6,
            symbol: "createProject",
            change: "Throw when `createProject` receives a null user.",
          },
        ],
      };
  return {
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    revisionId: packet.revisionId,
    gitFingerprint: packet.currentFingerprint,
    files: draftFiles(packet),
    threads: [
      {
        id: "thread_sandbox_auth",
        title: overrides.authThreadTitle ?? "Auth validation",
        summary:
          overrides.authThreadSummary ??
          "Project creation rejects missing users before creating data.",
        claims: [authClaim],
      },
      {
        id: "thread_sandbox_workspace",
        title: "Workspace validation",
        summary:
          workspaceStatus === "new"
            ? "Workspace validation rejects missing names."
            : "Workspace validation now exposes a validation version marker.",
        claims: [
          {
            id: "claim_sandbox_workspace_required",
            threadId: "thread_sandbox_workspace",
            title:
              workspaceStatus === "new"
                ? "Reject workspace inputs without a name"
                : "Expose workspace validation version marker",
            description:
              workspaceStatus === "new"
                ? "Workspace validation rejects inputs without a workspace name."
                : "Workspace validation rejects inputs without a workspace name and exposes a validation version marker.",
            before:
              workspaceStatus === "new"
                ? "Workspace inputs were accepted without a name check."
                : "Workspace validation rejected missing names only.",
            after:
              workspaceStatus === "new"
                ? "Workspace validation rejects inputs without a workspace name."
                : "Workspace validation rejects missing names and exposes a version marker.",
            agentStatus: workspaceStatus,
            importance: "minor",
            humanStatus: "unreviewed",
            evidences: [
              {
                filePath: "src/workspace.ts",
                startLine: 1,
                endLine: workspaceStatus === "new" ? 6 : 8,
                symbol: "validateWorkspace",
                change:
                  workspaceStatus === "new"
                    ? "Reject workspace inputs when the workspace name is missing."
                    : "Expose `workspaceValidationVersion` after validating the workspace name.",
              },
            ],
          },
        ],
      },
    ],
  };
}

function draftFiles(packet: {
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
}) {
  return packet.changedFiles.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    disposition: "pending",
  }));
}

function makeLargeLockPackages() {
  return Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => [
      `node_modules/package-${index}`,
      { version: `1.0.${index}`, resolved: `https://example.com/${index}` },
    ]),
  );
}
