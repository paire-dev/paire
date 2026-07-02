import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "paire-smoke-"));
const repo = join(root, "repo");
const home = join(root, "paire-home");
const browserCapture = join(root, "browser.txt");
const htmlCapture = join(root, "review.html");
const cliPath = resolve(import.meta.dirname, "../src/cli.ts");

run(["git", "init", "-b", "main", repo], root);
run(["git", "config", "user.email", "smoke@example.com"], repo);
run(["git", "config", "user.name", "Paire Smoke"], repo);
await write(join(repo, "src/app.ts"), ["export const value = 1;", ""]);
run(["git", "add", "."], repo);
run(["git", "commit", "-m", "initial"], repo);

runPaire(["start", "--base", "main", "--goal", "CLI smoke workflow"]);
await write(join(repo, "src/app.ts"), [
  "export function createProject(user: { id: string } | null, name: string) {",
  "  if (!user) {",
  "    throw new Error('Unauthorized');",
  "  }",
  "  return { ownerId: user.id, name };",
  "}",
  "",
]);
await write(join(repo, "src/workspace.ts"), [
  "export function validateWorkspace(input: { name?: string }) {",
  "  if (!input.name) {",
  "    throw new Error('Missing workspace name');",
  "  }",
  "  return input.name.trim();",
  "}",
  "",
]);
commitAll("add auth and workspace validation");

const firstReview = runPaire(["review"]);
assert(firstReview.includes("Review context ready."));
assert(!firstReview.includes("ACTION_REQUIRED"));
assert(!existsSync(browserCapture));

const badClaim = runPaireResult([
  "claim",
  "add",
  "--claim-id",
  "claim_bad",
  "--thread-id",
  "thread_smoke",
  "--title",
  "Bad evidence",
  "--importance",
  "minor",
  "--before",
  "Before.",
  "--after",
  "After.",
  "--evidence",
  "src/missing.ts:1-1:Reference missing file",
]);
assert(badClaim.exitCode !== 0);
assert(badClaim.stderr.includes("PAIRE_COMMAND_REJECTED"));
assert(badClaim.stderr.includes("UNKNOWN_FILE"));

runPaire([
  "claim",
  "add",
  "--claim-id",
  "claim_smoke_auth_required",
  "--thread-id",
  "thread_smoke_auth_workspace",
  "--thread-title",
  "Smoke auth and workspace validation",
  "--title",
  "Reject missing users before create",
  "--importance",
  "important",
  "--before",
  "Project creation accepted any user input.",
  "--after",
  "Project creation rejects missing users before returning data.",
  "--evidence",
  "src/app.ts:1-6:Throw when createProject receives a null user",
]);
const rejectedFinalize = runPaireResult(["review", "finalize"]);
assert(rejectedFinalize.exitCode !== 0);
assert(rejectedFinalize.stderr.includes("FILE_NOT_COVERED"));

runPaire([
  "claim",
  "add",
  "--claim-id",
  "claim_smoke_workspace_required",
  "--thread-id",
  "thread_smoke_auth_workspace",
  "--title",
  "Reject workspace inputs without a name",
  "--importance",
  "minor",
  "--before",
  "Workspace validation accepted missing names.",
  "--after",
  "Workspace validation rejects inputs without a workspace name.",
  "--evidence",
  "src/workspace.ts:1-6:Reject workspace inputs without a name",
]);
runPaire(["claim", "edit", "--claim", "claim_smoke_auth_required", "--work-status", "complete"]);
runPaire(["review", "finalize"]);

await Bun.write(browserCapture, "");
runPaire(["server", "start", "--no-open"]);
runPaire(["review", "--open"]);
assert((await Bun.file(browserCapture).text()).includes("http://127.0.0.1:"));

const list = runPaire(["review", "list", "--json"]);
assert(JSON.parse(list).length >= 1);
runPaire(["server", "stop", "--all"]);

console.log(`Sandbox: ${root}`);
console.log(`Repo: ${repo}`);
console.log(`Paire home: ${home}`);
console.log(`Latest HTML capture: ${htmlCapture}`);
console.log("");
console.log("Open the synced review manually with:");
console.log(
  `cd ${shellQuote(repo)} && PAIRE_HOME=${shellQuote(home)} bun ${shellQuote(cliPath)} review --open`,
);

function runPaire(args: string[]) {
  const result = runPaireResult(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `paire ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runPaireResult(args: string[]) {
  const result = Bun.spawnSync([process.execPath, cliPath, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      PAIRE_HOME: home,
      PAIRE_BROWSER_CAPTURE: browserCapture,
      PAIRE_BROWSER_HTML_CAPTURE: htmlCapture,
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
    throw new Error(`${args.join(" ")} failed: ${text(result.stderr)}`);
  }
}

function commitAll(message: string) {
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", message], repo);
}

async function write(path: string, lines: string[]) {
  run(["mkdir", "-p", dirname(path)], root);
  await Bun.write(path, lines.join("\n"));
}

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Smoke assertion failed.");
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
