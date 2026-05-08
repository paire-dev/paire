import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, writeRepoConfig } from "../lib/config";
import { ensureGitRepo } from "../lib/git";
import { answerString, type CommandResult, type GlobalOptions, type JsonValue } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";
import { installHooks, parseHooks } from "../hooks/install";

export async function initCommand(args: string[], options: GlobalOptions, answers: Record<string, JsonValue>): Promise<CommandResult> {
  await ensureGitRepo(options.cwd);
  const hooksValue = getFlagValue(args, "hooks") ?? answerString(answers, "hooks") ?? (options.yes ? "pre-commit,pre-push" : "");
  const hooks = parseHooks(hooksValue);
  const configPath = writeRepoConfig(options.cwd, { ...defaultConfig, hooks });
  const installedHooks = installHooks(options.cwd, hooks);
  const agentsPath = appendAgentsRule(options.cwd);

  return {
    exitCode: ExitCode.Success,
    message: `Initialized Paire at ${configPath}`,
    data: { configPath, installedHooks, agentsPath },
  };
}

function getFlagValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function appendAgentsRule(cwd: string): string {
  const path = join(cwd, "AGENTS.md");
  const rule = "- Before pushing, run `paire it` or `paire push` to generate the Paire brief.\n";
  if (existsSync(path) && readFileSync(path, "utf8").includes("paire it")) return path;
  appendFileSync(path, `${existsSync(path) ? "\n" : "# Agent instructions\n\n"}${rule}`);
  return path;
}
