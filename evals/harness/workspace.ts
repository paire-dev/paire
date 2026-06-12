import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FixtureSpec } from "./types";

export type EvalWorkspace = {
  root: string;
  repoDir: string;
  paireHome: string;
  env: Record<string, string | undefined>;
};

export async function createEvalWorkspace(fixture: FixtureSpec) {
  const root = mkdtempSync(join(tmpdir(), `paire-eval-${fixture.id}-`));
  const repoDir = join(root, "repo");
  const paireHome = join(root, "paire-home");
  run(["git", "init", "-b", "main", repoDir], root);
  run(["git", "config", "user.email", "eval@example.com"], repoDir);
  run(["git", "config", "user.name", "Paire Eval"], repoDir);
  await fixture.setup(repoDir);
  commitAll(repoDir, "initial");
  return {
    root,
    repoDir,
    paireHome,
    env: {
      ...process.env,
      PAIRE_HOME: paireHome,
      PAIRE_BROWSER_CAPTURE: join(root, "browser.txt"),
      PAIRE_BROWSER_HTML_CAPTURE: join(root, "review.html"),
    },
  } satisfies EvalWorkspace;
}

export async function applyFixtureChange(
  workspace: EvalWorkspace,
  fixture: FixtureSpec,
) {
  await fixture.change(workspace.repoDir);
  commitAll(workspace.repoDir, "fixture change");
}

export function runPaire(
  workspace: EvalWorkspace,
  paireBin: string,
  args: string[],
) {
  const command = paireCommand(paireBin, args);
  const started = Date.now();
  const result = Bun.spawnSync(command, {
    cwd: workspace.repoDir,
    env: workspace.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    argv: args,
    exitCode: result.exitCode,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
    wallMs: Date.now() - started,
  };
}

export function extractDraftPath(stdout: string) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/") && trimmed.endsWith("review-draft.json")) {
      return trimmed;
    }
  }
  throw new Error(`review-draft.json path missing from output:\n${stdout}`);
}

export function commitAll(repoDir: string, message: string) {
  run(["git", "add", "."], repoDir);
  run(["git", "commit", "-m", message], repoDir);
}

export function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${text(result.stderr)}`);
  }
}

export function writeInvocationLog(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "a" });
}

function paireCommand(paireBin: string, args: string[]) {
  if (paireBin.endsWith(".ts")) {
    return [process.execPath, resolve(paireBin), ...args];
  }
  return [resolve(paireBin), ...args];
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}
