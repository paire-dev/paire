import { spawnSync } from "node:child_process";
import { CliError } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

export function runAgent(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new CliError(result.stderr || `${command} failed`, ExitCode.AgentError);
  }

  return result.stdout;
}
