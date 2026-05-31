import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadImpactContext, renderImpactPrompt } from "../brief/impact";
import { ensureGitRepo } from "../lib/git";
import { readConfig } from "../lib/config";
import { type CommandResult, type GlobalOptions } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

const DEFAULT_OUTPUT = join(".paire", "impact.md");

export async function impactCommand(args: string[], options: GlobalOptions): Promise<CommandResult> {
  await ensureGitRepo(options.cwd);
  const config = readConfig(options.cwd);

  const baseFlag = getFlagValue(args, "base") ?? config.baseBranch;
  const outputRel = getFlagValue(args, "output") ?? DEFAULT_OUTPUT;
  const outputAbs = isAbsolute(outputRel) ? outputRel : join(options.cwd, outputRel);
  const promptOutFlag = getFlagValue(args, "prompt-out");

  const context = await loadImpactContext(options.cwd, baseFlag);
  const prompt = renderImpactPrompt(context, outputRel);

  mkdirSync(dirname(outputAbs), { recursive: true });

  if (promptOutFlag) {
    const promptAbs = isAbsolute(promptOutFlag) ? promptOutFlag : join(options.cwd, promptOutFlag);
    mkdirSync(dirname(promptAbs), { recursive: true });
    writeFileSync(promptAbs, prompt);
  }

  return {
    exitCode: ExitCode.Success,
    message: prompt,
    data: {
      branch: context.branch,
      baseRef: context.baseRef,
      title: context.title,
      outputPath: outputRel,
      promptPath: promptOutFlag ?? null,
      changedFiles: context.files.length,
      omittedFiles: context.truncatedFileCount,
    },
  };
}

function getFlagValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
