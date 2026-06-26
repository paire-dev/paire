import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAIRE_AGENT_MARKER = "<!-- paire -->";
export const PAIRE_AGENT_MARKER_END = "<!-- /paire -->";

// Matches a previously-installed block so `paire install` can refresh it in
// place. Tolerant of legacy/hand-edited closing markers (e.g. "<!--/ paire -->").
const PAIRE_BLOCK_PATTERN = /<!-- paire -->[\s\S]*?<!--\s*\/\s*paire\s*-->/;

export const PAIRE_AGENT_INSTRUCTIONS = [
  PAIRE_AGENT_MARKER,
  "## Paire",
  "",
  "Run `paire it`, then update review state only with Paire commands.",
  "",
  "- Inspect context with `paire review context`.",
  "- Add claims with `paire claim add --title ... --importance ... --thread-id ... --before ... --after ... --evidence path:start-end:change`.",
  "- Update progress with `paire claim edit --claim <id> --work-status <pending|in_progress|complete|blocked>`.",
  "- Acknowledge generated/mechanical files with `paire file acknowledge --path <path> --reason <text>`.",
  "- Finish with `paire review finalize`; fix any `PAIRE_COMMAND_REJECTED` issues and rerun the same command.",
  "- During Paire review, skip tests, typecheck, builds, and extra diffs unless Paire prints them.",
  PAIRE_AGENT_MARKER_END,
].join("\n");

export type InstallAgentInstructionsResult = {
  updated: string[];
  unchanged: string[];
  missing: string[];
};

const TARGET_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

// Insert the Paire block, or replace an existing one in place so re-running
// `paire install` always lands the current instructions.
export function upsertPaireBlock(content: string): string {
  if (PAIRE_BLOCK_PATTERN.test(content)) {
    return content.replace(PAIRE_BLOCK_PATTERN, () => PAIRE_AGENT_INSTRUCTIONS);
  }
  if (content.includes(PAIRE_AGENT_MARKER)) {
    // Legacy install: start marker with no recognizable closing marker. The
    // old block was appended to the end, so replace from the marker onward.
    const head = content
      .slice(0, content.indexOf(PAIRE_AGENT_MARKER))
      .replace(/\n+$/, "");
    return head.length > 0
      ? `${head}\n\n${PAIRE_AGENT_INSTRUCTIONS}\n`
      : `${PAIRE_AGENT_INSTRUCTIONS}\n`;
  }
  const trimmed = content.replace(/\n+$/, "");
  return trimmed.length > 0
    ? `${trimmed}\n\n${PAIRE_AGENT_INSTRUCTIONS}\n`
    : `${PAIRE_AGENT_INSTRUCTIONS}\n`;
}

export function installAgentInstructions(
  repoRoot: string,
): InstallAgentInstructionsResult {
  const updated: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];

  for (const file of TARGET_FILES) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    const content = readFileSync(path, "utf8");
    const next = upsertPaireBlock(content);
    if (next === content) {
      unchanged.push(file);
      continue;
    }
    writeFileSync(path, next);
    updated.push(file);
  }

  return { updated, unchanged, missing };
}

export function formatInstallResult(result: InstallAgentInstructionsResult) {
  const lines = ["Paire agent instructions"];
  if (result.updated.length > 0) {
    lines.push(`Updated: ${result.updated.join(", ")}`);
  }
  if (result.unchanged.length > 0) {
    lines.push(`Already up to date: ${result.unchanged.join(", ")}`);
  }
  if (result.missing.length > 0) {
    lines.push(`Not found (skipped): ${result.missing.join(", ")}`);
  }
  if (result.updated.length === 0 && result.unchanged.length === 0) {
    lines.push(
      "No agent instruction files found. Create AGENTS.md or CLAUDE.md, then run paire install again.",
    );
  }
  return lines.join("\n");
}
