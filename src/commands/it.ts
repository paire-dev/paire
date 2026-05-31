import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createBrief, renderHtml, renderMarkdown } from "../brief/render";
import { ensureGitRepo } from "../lib/git";
import { readConfig } from "../lib/config";
import { type CommandResult, type GlobalOptions } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

export async function itCommand(args: string[], options: GlobalOptions): Promise<CommandResult> {
  await ensureGitRepo(options.cwd);
  const config = readConfig(options.cwd);
  const brief = await createBrief(options.cwd, config.baseBranch);
  const format = getFlagValue(args, "format") ?? "html";
  const outDir = join(options.cwd, ".paire");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, format === "md" ? "brief.md" : "brief.html");
  const rendered = format === "md" ? renderMarkdown(brief) : renderHtml(brief);
  writeFileSync(outPath, rendered);

  if (!args.includes("--no-open") && format !== "md" && process.stdout.isTTY) {
    openFile(outPath);
  }

  return {
    exitCode: ExitCode.Success,
    message: `Wrote Paire brief to ${outPath}`,
    data: { path: outPath, branch: brief.branch, format },
  };
}

function getFlagValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function openFile(path: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", path] : [path];
  spawnSync(command, args, { stdio: "ignore" });
}
