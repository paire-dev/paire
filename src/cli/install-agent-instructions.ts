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
  "`paire it` is a command. **Run it verbatim, then do only what its output says.** Paire is the entire review workflow — you do not review, test, or build the code yourself.",
  "",
  "- Do **not** run the test suite, typecheck, build, or an exploratory `git diff` as part of this workflow. Run only the exact commands Paire prints.",
  "- Paire reviews **committed** code. If it prints `PAIRE_NEEDS_COMMITTED_CHANGES`, commit (or stash) your changes and run `paire it` again.",
  "- When it prints **Action required**, do the steps in order: inspect the diff range it names, edit the review draft in place (never create a new file), then run `paire review --apply <draft>`.",
  "- If apply prints `PAIRE_APPLY_REJECTED`, fix the draft per the listed issues and re-run. You are done only when `paire review --apply` exits 0.",
  "- An unrelated test or build failure is not a Paire step — don't chase it from inside this workflow.",
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
