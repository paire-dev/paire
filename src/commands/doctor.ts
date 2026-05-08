import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homeConfigPath, repoConfigPath } from "../lib/config";
import { hasGitDir } from "../lib/git";
import { type CommandResult, type GlobalOptions } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

export async function doctorCommand(_args: string[], options: GlobalOptions): Promise<CommandResult> {
  const homeConfig = homeConfigPath();
  const diagnostics = {
    cwd: options.cwd,
    hasHome: Boolean(process.env.HOME || process.env.USERPROFILE),
    homeConfigPath: homeConfig ?? null,
    homeConfigExists: homeConfig ? existsSync(homeConfig) : false,
    repoConfigPath: repoConfigPath(options.cwd),
    repoConfigExists: existsSync(repoConfigPath(options.cwd)),
    stdoutTty: Boolean(process.stdout.isTTY),
    stdinTty: Boolean(process.stdin.isTTY),
    inGitRepo: hasGitDir(options.cwd) || commandOk("git", ["rev-parse", "--git-dir"], options.cwd),
    ghAvailable: commandOk("gh", ["--version"], options.cwd),
  };

  return {
    exitCode: ExitCode.Success,
    message: Object.entries(diagnostics).map(([key, value]) => `${key}: ${String(value)}`).join("\n"),
    data: diagnostics,
  };
}

function commandOk(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, { cwd, stdio: "ignore" });
  return result.status === 0;
}
