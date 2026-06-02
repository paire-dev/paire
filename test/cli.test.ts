import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
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
  expect(review.stdout).toContain("Step 1 — Inspect the git diff (required)");
  expect(review.stdout).toContain("Step 5 — Open the Review UI (required)");
  expect(review.stdout).toContain("Do not skip steps");
  expect(review.stdout).toContain(
    "After any `paire review` command prints a Review UI URL, open that URL in the browser.",
  );
  expect(existsSync(fixture.browserCapture)).toBe(false);

  const packetPath = extractPacketPath(review.stdout);
  expect(packetPath).toContain(`${fixture.home}/projects/`);
  const packet = JSON.parse(readFileSync(packetPath, "utf8"));
  expect(review.stdout).toContain('"packetId"');
  expect(review.stdout).toContain(packet.currentFingerprint);
  const agentResultPath = join(fixture.root, "agent-result.json");
  writeFileSync(
    agentResultPath,
    JSON.stringify(hardcodedAgentResult(packet), null, 2),
  );

  const apply = runPaire(fixture, ["review", "--apply", agentResultPath]);
  expect(apply.exitCode).toBe(0);
  expect(apply.stdout).toContain("Review burden:");
  expect(apply.stdout).toContain("Open this URL in the browser:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );
  const html = readFileSync(fixture.htmlCapture, "utf8");
  expect(html).toContain('src="./main.tsx"');
  expect(html).not.toContain('data-human-status="concern"');
  expect(html).not.toContain('data-human-status="irrelevant"');
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
  expect(claims?.count).toBe(1);
  expect(evidences?.count).toBe(1);
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
  const reviewAgain = runPaire(fixture, ["review"]);
  expect(reviewAgain.exitCode).toBe(0);
  expect(reviewAgain.stdout).not.toContain("Action required");
  expect(reviewAgain.stdout).toContain("Open this URL in the browser:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );
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

  const firstResult = join(fixture.root, "sandbox-agent-result.json");
  writeFileSync(
    firstResult,
    JSON.stringify(sandboxAgentResult(firstPacket, "new"), null, 2),
  );
  const firstApply = runPaire(fixture, ["review", "--apply", firstResult]);
  expect(firstApply.exitCode).toBe(0);
  expect(firstApply.stdout).toContain("Review burden: 2 new");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );

  writeFileSync(fixture.browserCapture, "");
  const reopen = runPaire(fixture, ["review"]);
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

  const secondResult = join(fixture.root, "sandbox-agent-result-2.json");
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
  db.close();
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

  const server = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "_review-serve", session!.id],
    {
      cwd: fixture.repo,
      env: { ...process.env, PAIRE_HOME: fixture.home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const state = await waitForServerState(fixture.home, session!.id);
    const reviewResponse = await fetch(`${state.url}api/review`);
    expect(reviewResponse.ok).toBe(true);
    const reviewText = await reviewResponse.text();
    expect(reviewText).not.toContain('"diff":"diff --git');
    const reviewData = JSON.parse(reviewText);
    const evidence = reviewData.threads[0].claims[0].evidences[0];
    expect(evidence.claimId).toBe("claim_auth_before_create");

    const reviewDiffResponse = await fetch(`${state.url}api/review/diff`);
    expect(reviewDiffResponse.ok).toBe(true);
    const reviewDiffPayload = await reviewDiffResponse.json();
    expect(reviewDiffPayload.diff).toContain(
      "diff --git a/src/app.ts b/src/app.ts",
    );
    expect(reviewDiffPayload.diff).toContain("throw new Error('Unauthorized')");

    const diffResponse = await fetch(
      `${state.url}api/claims/${encodeURIComponent(evidence.claimId)}/evidence-diff?filePath=${encodeURIComponent(evidence.filePath)}`,
    );
    expect(diffResponse.ok).toBe(true);
    const diffPayload = await diffResponse.json();
    expect(diffPayload.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(diffPayload.diff).toContain("throw new Error('Unauthorized')");
  } finally {
    server.kill();
    await server.exited;
  }
});

test("dirty worktree opens review UI with committed-state warning", () => {
  const fixture = createFixtureRepo();
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const start = runPaire(fixture, ["start", "--base", "main"]);
  expect(start.exitCode).toBe(0);

  const review = runPaire(fixture, ["review"]);
  expect(review.exitCode).toBe(0);
  expect(review.stdout).toContain("PAIRE_NEEDS_COMMITTED_CHANGES");
  expect(review.stdout).toContain("Paire reviews committed code only");
  expect(review.stdout).toContain(
    "commit changes; paire it; and follow all the instructions to review and apply.",
  );
  expect(review.stdout).toContain("Step 2 — Run Paire again (required)");
  expect(review.stdout).toContain("Open this URL in the browser:");
  expect(readFileSync(fixture.browserCapture, "utf8")).toContain(
    "http://127.0.0.1:",
  );
  expect(readFileSync(fixture.htmlCapture, "utf8")).toContain(
    'src="./main.tsx"',
  );
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

test("reset removes exported agent-result and current-packet", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value to two");

  const review = runPaire(fixture, ["review"]);
  const packetPath = extractPacketPath(review.stdout);
  const exportDir = dirname(packetPath);
  const agentResultPath = join(exportDir, "agent-result.json");
  writeFileSync(agentResultPath, JSON.stringify({ stale: true }, null, 2));
  expect(existsSync(packetPath)).toBe(true);
  expect(existsSync(agentResultPath)).toBe(true);

  expect(runPaire(fixture, ["reset"]).exitCode).toBe(0);
  expect(existsSync(agentResultPath)).toBe(false);
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
  expect(apply.stderr).toContain("Stale Paire review update");
  expect(existsSync(fixture.browserCapture)).toBe(false);

  const db = new Database(join(fixture.home, "paire.db"));
  const claims = db
    .query<{ count: number }, []>("select count(*) as count from claims")
    .get();
  expect(claims?.count).toBe(0);
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
  expect(agents).toContain("When you **git push**, run `paire it`");
  expect(agents).toContain("paire review --apply");
  expect(claude).toContain("<!-- paire -->");
  expect(claude).toContain("When you **git push**, run `paire it`");

  const second = runPaire(fixture, ["install"]);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain("Already installed: AGENTS.md, CLAUDE.md");
  expect(readFileSync(agentsPath, "utf8")).toBe(agents);
});

test("paire install skips missing agent instruction files", () => {
  const fixture = createFixtureRepo();
  writeFileSync(join(fixture.repo, "AGENTS.md"), "# Agent rules\n");

  const result = runPaire(fixture, ["install"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Updated: AGENTS.md");
  expect(result.stdout).toContain("Not found (skipped): CLAUDE.md");
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
  expect(text(review.stdout)).toContain("PAIRE_NEEDS_COMMITTED_CHANGES");
  expect(text(review.stdout)).toContain("Open this URL in the browser:");

  const db = new Database(join(fixture.home, "paire.db"));
  const session = db.query<{ id: string }, []>("select id from sessions").get();
  db.close();
  expect(session?.id).toBeTruthy();

  const state = await waitForServerState(fixture.home, session!.id);
  const reviewResponse = await fetch(`${state.url}api/review`);
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

function createFixtureRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paire-cli-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const browserCapture = join(root, "browser.txt");
  const htmlCapture = join(root, "review.html");
  run(["git", "init", "-b", "main", repo], root);
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  run(["mkdir", "-p", "src"], repo);
  writeFileSync(join(repo, "src/app.ts"), "export const value = 1;\n");
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", "initial"], repo);
  const fixture = { root, repo, home, browserCapture, htmlCapture };
  fixtures.push(fixture);
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

function commitAll(repo: string, message: string) {
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", message], repo);
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}

function extractPacketPath(stdout: string) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("/") &&
      trimmed.endsWith("current-packet.json") &&
      !trimmed.includes("--apply")
    ) {
      return trimmed;
    }
  }
  throw new Error(`Packet path missing from output:\n${stdout}`);
}

async function waitForServerState(home: string, sessionId: string) {
  const path = join(home, "review-servers", `${sessionId}.json`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as {
        url: string;
        pid?: number;
      };
    }
    await Bun.sleep(50);
  }
  throw new Error("Review server did not start.");
}

function hardcodedAgentResult(packet: {
  packetId: string;
  sessionId: string;
  revisionId: string;
  currentFingerprint: string;
}) {
  return {
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    revisionId: packet.revisionId,
    gitFingerprint: packet.currentFingerprint,
    threads: [
      {
        id: "thread_workspace_validation",
        title: "Workspace validation",
        summary:
          "Project creation now rejects missing users before creating data.",
        status: "active",
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
  },
  workspaceStatus: "new" | "amended",
  overrides: {
    authThreadTitle?: string;
    authThreadSummary?: string;
    authClaimTitle?: string;
    authClaimDescription?: string;
    authClaimBefore?: string;
    authClaimAfter?: string;
  } = {},
) {
  return {
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    revisionId: packet.revisionId,
    gitFingerprint: packet.currentFingerprint,
    threads: [
      {
        id: "thread_sandbox_auth",
        title: overrides.authThreadTitle ?? "Auth validation",
        summary:
          overrides.authThreadSummary ??
          "Project creation rejects missing users before creating data.",
        status: "active",
        claims: [
          {
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
          },
        ],
      },
      {
        id: "thread_sandbox_workspace",
        title: "Workspace validation",
        summary:
          workspaceStatus === "new"
            ? "Workspace validation rejects missing names."
            : "Workspace validation now exposes a validation version marker.",
        status: "active",
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

function makeLargeLockPackages() {
  return Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => [
      `node_modules/package-${index}`,
      { version: `1.0.${index}`, resolved: `https://example.com/${index}` },
    ]),
  );
}
