import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAIRE_AGENT_MARKER = "<!-- paire -->";

export const PAIRE_AGENT_INSTRUCTIONS = [
  "",
  PAIRE_AGENT_MARKER,
  "## Paire",
  "",
  "When you **git push**, run `paire it` and follow every instruction Paire prints until the workflow is complete.",
  "",
  "- Paire reviews **committed** code only — commit worktree changes before running Paire.",
  "- When output shows **Action required**, finish all steps in order: inspect the diff, edit the review draft in place, and run `paire review --apply <draft>` until it exits 0.",
  "- Do not consider the task done until `paire review --apply` succeeds.",
  "",
].join("\n");

export type InstallAgentInstructionsResult = {
  updated: string[];
  skipped: string[];
  missing: string[];
};

const TARGET_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export function installAgentInstructions(
  repoRoot: string,
): InstallAgentInstructionsResult {
  const updated: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  for (const file of TARGET_FILES) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    const content = readFileSync(path, "utf8");
    if (content.includes(PAIRE_AGENT_MARKER)) {
      skipped.push(file);
      continue;
    }
    const suffix = content.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${content}${suffix}${PAIRE_AGENT_INSTRUCTIONS}`);
    updated.push(file);
  }

  return { updated, skipped, missing };
}

export function formatInstallResult(result: InstallAgentInstructionsResult) {
  const lines = ["Paire agent instructions"];
  if (result.updated.length > 0) {
    lines.push(`Updated: ${result.updated.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Already installed: ${result.skipped.join(", ")}`);
  }
  if (result.missing.length > 0) {
    lines.push(`Not found (skipped): ${result.missing.join(", ")}`);
  }
  if (result.updated.length === 0 && result.skipped.length === 0) {
    lines.push(
      "No agent instruction files found. Create AGENTS.md or CLAUDE.md, then run paire install again.",
    );
  }
  return lines.join("\n");
}
