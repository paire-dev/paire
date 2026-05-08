import { spawnSync } from "node:child_process";
import { createBrief, renderMarkdown } from "../brief/render";
import { ensureGitRepo } from "../lib/git";
import { CliError, type CommandResult, type GlobalOptions } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

export async function pushCommand(args: string[], options: GlobalOptions): Promise<CommandResult> {
  await ensureGitRepo(options.cwd);
  const dryRun = args.includes("--dry-run");
  const brief = await createBrief(options.cwd);
  const body = renderMarkdown(brief);

  if (!dryRun) {
    const result = spawnSync("gh", ["pr", "edit", "--body", body], { cwd: options.cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new CliError(result.stderr || "gh pr edit failed", ExitCode.AgentError);
    }
  }

  return {
    exitCode: ExitCode.Success,
    message: dryRun ? body : "Updated PR description with Paire brief",
    data: { branch: brief.branch, dryRun, body: options.json ? body : null },
  };
}
