import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
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

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ReviewServerState = {
  port: number;
  url: string;
  token: string;
};

const cliPath = resolve(import.meta.dirname, "../src/cli.ts");
const fixtures: Fixture[] = [];

beforeEach(() => {
  fixtures.length = 0;
});

afterEach(() => {
  for (const fixture of fixtures) {
    runPaire(fixture, ["server", "stop", "--all"]);
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("committed review uses claim commands and finalizes canonical state", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);

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
  commitAll(fixture.repo, "add auth check");

  const review = runPaire(fixture, ["review"]);
  expect(review.exitCode).toBe(0);
  expect(review.stdout).toContain("Review context ready.");
  expect(review.stdout).toContain("paire claim add");
  expect(review.stdout).not.toContain("ACTION_REQUIRED");
  expect(review.stdout).not.toContain("review-draft.json");

  const claim = runPaire(fixture, [
    "claim",
    "add",
    "--claim-id",
    "claim_auth",
    "--thread-id",
    "thread_auth",
    "--title",
    "Reject missing users",
    "--importance",
    "important",
    "--before",
    "Project creation accepted a missing user.",
    "--after",
    "Project creation rejects a missing user.",
    "--evidence",
    "src/app.ts:1-6:Reject missing users before creating projects",
  ]);
  expect(claim.exitCode).toBe(0);
  expect(claim.stdout).toContain("CLAIM_ADDED claim_auth");
  expect(claim.stdout).toContain("0 pending");

  const edit = runPaire(fixture, [
    "claim",
    "edit",
    "--claim",
    "claim_auth",
    "--work-status",
    "complete",
  ]);
  expect(edit.exitCode).toBe(0);

  const finalized = runPaire(fixture, ["review", "finalize"]);
  expect(finalized.exitCode).toBe(0);
  expect(finalized.stdout).toContain("REVIEW_FINALIZED");

  const state = latestReviewState(fixture);
  expect(state.schemaVersion).toBe(3);
  expect(state.target.mode).toBe("committed");
  expect(state.claims).toHaveLength(1);
  expect(state.claims[0]).toMatchObject({
    id: "claim_auth",
    workStatus: "complete",
    lifecycleStatus: "active",
    humanStatus: "unreviewed",
  });
  expect(state.threads[0]).not.toHaveProperty("claims");
  expect(state.claimHistory.map((revision: { version: number }) => revision.version))
    .toEqual([1, 2]);
  expect(state.events.map((event: { type: string }) => event.type)).toEqual([
    "claim_added",
    "claim_status_changed",
    "review_finalized",
  ]);
  expect(state.fileProgress).toMatchObject({ total: 1, pending: 0 });
  expect(state.finalizedAt).toBeTruthy();

  const list = runPaire(fixture, ["review", "list", "--json"]);
  expect(list.exitCode).toBe(0);
  expect(JSON.parse(list.stdout)[0]).toMatchObject({
    reviewId: state.reviewId,
    mode: "committed",
    status: "finalized",
    claimCount: 1,
  });

  const context = runPaire(fixture, [
    "review",
    "context",
    "--review",
    state.reviewId,
    "--json",
  ]);
  expect(context.exitCode).toBe(0);
  expect(JSON.parse(context.stdout)).toMatchObject({
    reviewId: state.reviewId,
    target: { mode: "committed" },
  });
});

test("coverage can be completed with file acknowledgement and invalid commands are atomic", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  writeFileSync(join(fixture.repo, "src/workspace.ts"), "export const workspace = true;\n");
  commitAll(fixture.repo, "add app and workspace");

  expect(runPaire(fixture, ["review"]).exitCode).toBe(0);
  expect(
    runPaire(fixture, [
      "claim",
      "add",
      "--claim-id",
      "claim_app",
      "--thread-id",
      "thread_app",
      "--title",
      "Update app value",
      "--importance",
      "minor",
      "--before",
      "The app exported the original value.",
      "--after",
      "The app exports the updated value.",
      "--evidence",
      "src/app.ts:1-1:Update the app value",
    ]).exitCode,
  ).toBe(0);

  const rejectedFinalize = runPaire(fixture, ["review", "finalize"]);
  expect(rejectedFinalize.exitCode).not.toBe(0);
  expect(rejectedFinalize.stderr).toContain("FILE_NOT_COVERED");

  const before = latestReviewState(fixture);
  const invalid = runPaire(fixture, [
    "claim",
    "evidence",
    "add",
    "--claim",
    "claim_app",
    "--evidence",
    "src/missing.ts:1-1:Reference an unknown file",
  ]);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr).toContain("UNKNOWN_FILE");
  expect(latestReviewState(fixture)).toEqual(before);

  const acknowledged = runPaire(fixture, [
    "file",
    "acknowledge",
    "--path",
    "src/workspace.ts",
    "--reason",
    "Mechanical fixture coverage for the command workflow",
  ]);
  expect(acknowledged.exitCode).toBe(0);
  expect(runPaire(fixture, ["review", "finalize"]).exitCode).toBe(0);

  const state = latestReviewState(fixture);
  expect(state.files.find((file: { path: string }) => file.path === "src/workspace.ts"))
    .toMatchObject({
      coverageStatus: "acknowledged",
      acknowledgementReason: "Mechanical fixture coverage for the command workflow",
    });
  expect(state.fileProgress.pendingFiles).toEqual([]);
});

test("review API returns canonical state and human status mutates only the claim", async () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");
  commitAll(fixture.repo, "change value");
  expect(runPaire(fixture, ["review"]).exitCode).toBe(0);
  expect(
    runPaire(fixture, [
      "claim",
      "add",
      "--claim-id",
      "claim_value",
      "--thread-id",
      "thread_value",
      "--title",
      "Change exported value",
      "--importance",
      "minor",
      "--before",
      "The module exported value one.",
      "--after",
      "The module exports value two.",
      "--evidence",
      "src/app.ts:1-1:Change the exported value",
    ]).exitCode,
  ).toBe(0);

  const sessionId = onlySessionId(fixture);
  expect(runPaire(fixture, ["server", "start", "--no-open"]).exitCode).toBe(0);
  const server = await waitForServerState(fixture.home, sessionId);
  const unauthenticated = await fetch(reviewApiUrl(server, "/api/review"));
  expect(unauthenticated.status).toBe(401);

  const review = await reviewApiFetch(server, "/api/review").then((response) =>
    response.json(),
  );
  expect(review.threads[0]).not.toHaveProperty("claims");
  expect(review.claims[0]).toMatchObject({
    id: "claim_value",
    threadId: "thread_value",
    workStatus: "pending",
    humanStatus: "unreviewed",
  });
  expect(review.claimHistory).toHaveLength(1);
  expect(review.fileProgress).toMatchObject({ pending: 0 });
  expect(review.events[0]).toMatchObject({ type: "claim_added" });

  const update = await fetch(
    reviewApiUrl(server, "/api/claims/claim_value/human-status"),
    {
      method: "POST",
      headers: {
        "x-paire-review-token": server.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ humanStatus: "accepted" }),
    },
  );
  expect(update.ok).toBe(true);
  const after = await reviewApiFetch(server, "/api/review").then((response) =>
    response.json(),
  );
  expect(after.claims[0]).toMatchObject({
    humanStatus: "accepted",
    workStatus: "pending",
  });
});

test("dirty worktree reviews use the same claim command model", () => {
  const fixture = createFixtureRepo();
  expect(runPaire(fixture, ["start", "--base", "main"]).exitCode).toBe(0);
  writeFileSync(join(fixture.repo, "src/app.ts"), "export const value = 2;\n");

  const it = runPaire(fixture, ["it"]);
  expect(it.exitCode).toBe(0);
  expect(it.stdout).toContain("Review context ready.");
  expect(it.stdout).toContain("worktree");
  expect(it.stdout).not.toContain("worktree-review-draft.json");

  const claim = runPaire(fixture, [
    "claim",
    "add",
    "--claim-id",
    "claim_worktree",
    "--thread-id",
    "thread_worktree",
    "--title",
    "Update worktree value",
    "--importance",
    "minor",
    "--before",
    "The worktree had the original value.",
    "--after",
    "The worktree has the new value.",
    "--evidence",
    "src/app.ts:1-1:Update the worktree value",
  ]);
  expect(claim.exitCode).toBe(0);
  expect(runPaire(fixture, ["review", "finalize"]).exitCode).toBe(0);

  const state = latestReviewState(fixture);
  expect(state.target.mode).toBe("uncommitted");
  expect(state.claims[0]).toMatchObject({ id: "claim_worktree" });
  expect(state.fileProgress.pending).toBe(0);
});

test("old apply commands are rejected and install instructions are command-based", () => {
  const fixture = createFixtureRepo();
  const rejected = runPaire(fixture, ["review", "--apply", "review-draft.json"]);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain("Manual review JSON apply is no longer supported");

  writeFileSync(join(fixture.repo, "AGENTS.md"), "# Agent instructions\n");
  const installed = runPaire(fixture, ["install"]);
  expect(installed.exitCode).toBe(0);
  const agents = readFileSync(join(fixture.repo, "AGENTS.md"), "utf8");
  expect(agents).toContain("paire claim add");
  expect(agents).toContain("paire review finalize");
  expect(agents).not.toContain("ACTION_REQUIRED");
  expect(agents).not.toContain("--apply");
});

function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "paire-cli-test-"));
  const repo = join(root, "repo");
  const home = join(root, "paire-home");
  const browserCapture = join(root, "browser.txt");
  const htmlCapture = join(root, "review.html");
  mkdirSync(join(repo, "src"), { recursive: true });
  run(["git", "init", "-b", "main", repo], root);
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Paire Test"], repo);
  writeFileSync(join(repo, "src/app.ts"), "export const value = 1;\n");
  commitAll(repo, "initial");
  const fixture = { root, repo, home, browserCapture, htmlCapture };
  fixtures.push(fixture);
  return fixture;
}

function runPaire(fixture: Fixture, args: string[]): RunResult {
  const result = Bun.spawnSync([process.execPath, cliPath, ...args], {
    cwd: fixture.repo,
    env: {
      ...process.env,
      PAIRE_HOME: fixture.home,
      PAIRE_BROWSER_CAPTURE: fixture.browserCapture,
      PAIRE_BROWSER_HTML_CAPTURE: fixture.htmlCapture,
      PAIRE_NO_UPGRADE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
  };
}

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${text(result.stderr)}`);
  }
}

function commitAll(repo: string, message: string) {
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", message], repo);
}

function latestReviewState(fixture: Fixture) {
  const db = new Database(join(fixture.home, "paire.db"));
  try {
    const row = db
      .query<{ stateJson: string }, []>(
        "select stateJson from review_states order by updatedAt desc limit 1",
      )
      .get();
    expect(row).toBeTruthy();
    return JSON.parse(row!.stateJson);
  } finally {
    db.close();
  }
}

function onlySessionId(fixture: Fixture) {
  const db = new Database(join(fixture.home, "paire.db"));
  try {
    const row = db
      .query<{ id: string }, []>("select id from sessions limit 1")
      .get();
    expect(row?.id).toBeTruthy();
    return row!.id;
  } finally {
    db.close();
  }
}

async function waitForServerState(home: string, sessionId: string) {
  const path = join(home, "review-servers", `${sessionId}.json`);
  for (let index = 0; index < 50; index += 1) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as ReviewServerState;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Review server state was not written: ${path}`);
}

function reviewApiUrl(state: ReviewServerState, path: string) {
  const base = state.url.split("/#")[0] ?? state.url;
  return new URL(path, base).toString();
}

function reviewApiFetch(state: ReviewServerState, path: string) {
  return fetch(reviewApiUrl(state, path), {
    headers: { "x-paire-review-token": state.token },
  });
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}
