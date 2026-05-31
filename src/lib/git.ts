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

export async function baseBranch(cwd: string): Promise<string> {
  // Use upstream only when it points to a different branch (e.g. origin/main),
  // not when it mirrors the current branch on origin (e.g. origin/feat → feat).
  try {
    const current = await git(["branch", "--show-current"], cwd);
    const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
    const upstreamShort = upstream.replace(/^[^/]+\//, "");
    if (upstreamShort !== current) return upstream;
  } catch {}
  // Fall back to common base branch names
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    try {
      await git(["rev-parse", "--verify", candidate], cwd);
      return candidate;
    } catch {}
  }
  throw new CliError("could not determine base branch", ExitCode.GitStateError);
}

export async function diff(cwd: string, base?: string): Promise<string> {
  const resolvedBase = base ?? await baseBranch(cwd);
  // Three-dot notation diffs from the merge-base of resolvedBase and HEAD to HEAD
  return git(["diff", "--stat", `${resolvedBase}...HEAD`], cwd);
}

export async function recentCommits(cwd: string, count = 5): Promise<string> {
  return git(["log", `-${count}`, "--oneline"], cwd);
}
