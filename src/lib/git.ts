import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { CliError } from "./io";
import { ExitCode } from "./exit-codes";

export function hasGitDir(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const output = await $`git ${args}`.cwd(cwd).quiet();
    return output.stdout.toString().trim();
  } catch {
    throw new CliError(`git ${args.join(" ")} failed`, ExitCode.GitStateError);
  }
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  if (hasGitDir(cwd)) return;
  try {
    await git(["rev-parse", "--git-dir"], cwd);
  } catch {
    throw new CliError("not inside a git repository", ExitCode.GitStateError);
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(["branch", "--show-current"], cwd);
}

export async function diff(cwd: string): Promise<string> {
  return git(["diff", "--stat", "--", "."], cwd);
}

export async function recentCommits(cwd: string, count = 5): Promise<string> {
  return git(["log", `-${count}`, "--oneline"], cwd);
}
