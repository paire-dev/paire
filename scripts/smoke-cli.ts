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
await write(join(repo, "src/app.ts"), [
  "export function createProject(name: string) {",
  "  return { name };",
  "}",
  "",
]);
await Bun.write(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
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
assert(firstReview.includes("ACTION REQUIRED"));
assert(!existsSync(browserCapture));
const firstPacketPath = extractPacketPath(firstReview);
const firstPacket = await Bun.file(firstPacketPath).json();
assert(
  firstPacket.changedFiles.some(
    (file: { path: string }) => file.path === "src/workspace.ts",
  ),
);
const firstResultPath = join(root, "review-draft-mutated.json");
const badFirstResult = agentResult(firstPacket, "new");
const firstBadThread = badFirstResult.threads[0];
const firstBadClaim = firstBadThread?.claims[0];
if (!firstBadThread || !firstBadClaim) {
  throw new Error("Smoke fixture did not produce a claim to mutate.");
}
firstBadThread.claims = [firstBadClaim];
await Bun.write(
  firstResultPath,
  JSON.stringify(badFirstResult, null, 2),
);
const rejectedApply = runPaireResult(["review", "--apply", firstResultPath]);
assert(rejectedApply.exitCode !== 0);
assert(rejectedApply.stderr.includes("PAIRE_APPLY_REJECTED"));
assert(rejectedApply.stderr.includes("file_not_covered"));

await Bun.write(
  firstResultPath,
  JSON.stringify(agentResult(firstPacket, "new"), null, 2),
);
runPaire(["review", "--apply", firstResultPath]);

await Bun.write(browserCapture, "");
const reopen = runPaire(["review"]);
assert(!reopen.includes("ACTION REQUIRED"));
assert((await Bun.file(browserCapture).text()).includes("http://127.0.0.1:"));

await write(join(repo, "src/workspace.ts"), [
  "export function validateWorkspace(input: { name?: string }) {",
  "  if (!input.name) {",
  "    throw new Error('Missing workspace name');",
  "  }",
  "  return input.name.trim();",
  "}",
  "",
  "export const workspaceValidationVersion = 2;",
  "",
]);
commitAll("add workspace validation version");
await Bun.write(browserCapture, "");
const secondReview = runPaire(["review"]);
assert(secondReview.includes("ACTION REQUIRED"));
assert((await Bun.file(browserCapture).text()) === "");
const secondPacketPath = extractPacketPath(secondReview);
const secondPacket = await Bun.file(secondPacketPath).json();
assert(
  secondPacket.changedFiles.some(
    (file: { path: string }) => file.path === "src/workspace.ts",
  ),
);
const secondResultPath = join(root, "review-draft-mutated-2.json");
await Bun.write(
  secondResultPath,
  JSON.stringify(agentResult(secondPacket, "amended"), null, 2),
);
runPaire(["review", "--apply", secondResultPath]);

await Bun.write(browserCapture, "");
runPaire(["review"]);
assert((await Bun.file(browserCapture).text()).includes("http://127.0.0.1:"));

console.log(`Sandbox: ${root}`);
console.log(`Repo: ${repo}`);
console.log(`Paire home: ${home}`);
console.log(`Latest HTML capture: ${htmlCapture}`);
console.log("");
console.log("Open the synced review manually with:");
console.log(
  `cd ${shellQuote(repo)} && PAIRE_HOME=${shellQuote(home)} bun ${shellQuote(cliPath)} review`,
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
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

function agentResult(
  packet: {
    packetId: string;
    sessionId: string;
    revisionId: string;
    currentFingerprint: string;
    changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  },
  workspaceStatus: "new" | "amended",
) {
  return {
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    revisionId: packet.revisionId,
    gitFingerprint: packet.currentFingerprint,
    files: packet.changedFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      disposition: "pending",
    })),
    threads: [
      {
        id: "thread_smoke_auth_workspace",
        title: "Smoke auth and workspace validation",
        summary:
          workspaceStatus === "new"
            ? "The smoke change adds auth and workspace validation behavior."
            : "The smoke change updates the workspace validation claim.",
        claims: [
          {
            id: "claim_smoke_auth_required",
            threadId: "thread_smoke_auth_workspace",
            title: "Reject missing users before create",
            description:
              "Project creation rejects missing users before returning project data.",
            before: "Project creation accepted any user input.",
            after:
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
          },
          {
            id: "claim_smoke_workspace_required",
            threadId: "thread_smoke_auth_workspace",
            title:
              workspaceStatus === "new"
                ? "Reject workspace inputs without a name"
                : "Expose workspace validation version marker",
            description:
              workspaceStatus === "new"
                ? "Workspace validation rejects inputs without a workspace name."
                : "Workspace validation rejects missing names and exposes a version marker.",
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

function assert(value: unknown) {
  if (!value) throw new Error("Smoke assertion failed.");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
