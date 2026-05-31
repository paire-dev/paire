import { baseBranch as detectBase, currentBranch, git } from "../lib/git";

const MAX_PATCH_CHARS_PER_FILE = 5000;
const MAX_FILES = 35;

export type ImpactFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
};

export type ImpactContext = {
  branch: string;
  baseRef: string;
  title: string;
  commitSubjects: string[];
  diffStat: string;
  files: ImpactFile[];
  truncatedFileCount: number;
};

export async function loadImpactContext(cwd: string, baseOverride?: string): Promise<ImpactContext> {
  const branch = await currentBranch(cwd);
  const baseRef = baseOverride ?? (await detectBase(cwd));

  const [diffStat, numStat, nameStatus, subjects] = await Promise.all([
    git(["diff", "--stat", `${baseRef}...HEAD`], cwd).catch(() => ""),
    git(["diff", "--numstat", `${baseRef}...HEAD`], cwd).catch(() => ""),
    git(["diff", "--name-status", `${baseRef}...HEAD`], cwd).catch(() => ""),
    git(["log", `${baseRef}..HEAD`, "--pretty=%s"], cwd).catch(() => ""),
  ]);

  const stats = parseNumStat(numStat);
  const statuses = parseNameStatus(nameStatus);
  const allFilenames = Array.from(stats.keys());
  const filenames = allFilenames.slice(0, MAX_FILES);

  const files = await Promise.all(
    filenames.map(async (filename): Promise<ImpactFile> => {
      const patch = await git(["diff", `${baseRef}...HEAD`, "--", filename], cwd).catch(() => "");
      const truncated =
        patch.length > MAX_PATCH_CHARS_PER_FILE
          ? `${patch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n... [patch truncated]`
          : patch;
      const stat = stats.get(filename) ?? { additions: 0, deletions: 0 };
      return {
        filename,
        status: statuses.get(filename) ?? "M",
        additions: stat.additions,
        deletions: stat.deletions,
        patch: truncated,
      };
    }),
  );

  const commitSubjects = subjects.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = commitSubjects[0] ?? branch ?? "(untitled change)";

  return {
    branch,
    baseRef,
    title,
    commitSubjects,
    diffStat,
    files,
    truncatedFileCount: Math.max(0, allFilenames.length - filenames.length),
  };
}

export function renderImpactPrompt(context: ImpactContext, outputPath: string): string {
  const fileManifest =
    context.files.length === 0
      ? "(no changed files)"
      : context.files
          .map(
            (file, index) =>
              `file_${index} = ${file.filename} [${file.status}, +${file.additions}/-${file.deletions}]`,
          )
          .join("\n");

  const patchBlock =
    context.files.length === 0
      ? "(no patches)"
      : context.files
          .map(
            (file, index) =>
              `--- file_${index} (${file.filename}) ---\n${file.patch || "(no textual patch)"}`,
          )
          .join("\n\n");

  const truncationNote =
    context.truncatedFileCount > 0
      ? `\n\n> ${context.truncatedFileCount} additional changed file(s) were omitted from this prompt to stay within budget. Mention this limitation in the summary if it materially affects coverage.`
      : "";

  const recentCommits =
    context.commitSubjects.length === 0
      ? "(no commits ahead of base)"
      : context.commitSubjects.map((subject) => `- ${subject}`).join("\n");

  return [
    "# Task: PR impact review",
    "",
    `You are reviewing this pull request for product impact. Write the result as Markdown to **${outputPath}** (overwrite if it exists), then stop. Do not run other shell commands; the diff context below is everything you need.`,
    "",
    "## Phase 1 — Areas",
    "Return only areas actually touched by this PR. Do not fill a fixed checklist.",
    "- If an area is touched but has small impact, include it as `low`. If untouched, omit it.",
    "- Sort areas high → medium → low. Most PRs should have 1–2 areas.",
    "- Each area must describe a different product dimension. No reworded duplicates.",
    "",
    "Starter labels: `UX`, `Behavior`, `Copy`, `Data`, `API`, `Money`, `Trust`, `Ops`, `Code`.",
    "Use a more specific label when clearer (e.g. `Auth`, `Search`, `Onboarding`, `Notifications`, `Compliance`, `Billing Admin`, `Developer Experience`).",
    "",
    "## Phase 2 — Items per area",
    "Generate 1–4 concrete items per area, or 0 if the area has no item worth showing.",
    "- Use `Before` + `After` when the PR changes existing behavior. Omit the Before row when the prior behavior is not proved by the diff and label the new column `New` instead of `After`.",
    "- Do not duplicate angle, title, summary, before, or after across items.",
    "- Avoid repeated templates like 'now adds', 'now triggers' across items.",
    "- **Evidence MUST use `file:line-range` format**, e.g. `src/feed/rank.ts:42-75`. Multiple ranges separated by commas.",
    "- Use changed line numbers from the diff. Do not invent metrics or behavior not supported by the diff.",
    "- Sort the most important item first.",
    "",
    "## Confidence levels",
    "- `observed` — the diff directly evidences the behavior",
    "- `inferred` — the behavior follows from the diff plus reasonable assumptions",
    "- `unknown` — state may have changed but the diff is ambiguous",
    "",
    "## Output format",
    `Write one Markdown file at \`${outputPath}\` using this exact structure (one \`<details>\` per item, grouped by area):`,
    "",
    "````markdown",
    "# PR impact review",
    "",
    "> One or two short sentences describing what changes if this PR merges. No file names. Do not invent metrics.",
    "",
    "<details open>",
    "<summary><kbd>{{Area}}</kbd> &middot; <strong>{{high|medium|low}}</strong> &middot; {{observed|inferred|unknown}} &mdash; {{Item title}}</summary>",
    "",
    "{{One sentence explaining what changes for a reviewer.}}",
    "",
    "| ← Before | → After |",
    "| --- | --- |",
    "| {{prior behavior}} | {{new behavior}} |",
    "",
    "`{{file:line-range}}`",
    "",
    "</details>",
    "````",
    "",
    "When prior behavior is not proved by the diff, replace the table with a single line: `→ New: {{new behavior}}` and drop the Before column.",
    "",
    "## PR context",
    "",
    `- Branch: \`${context.branch || "(detached)"}\` → \`${context.baseRef}\``,
    `- Title: ${context.title}`,
    "",
    "### Commits ahead of base",
    recentCommits,
    "",
    "### Diff stat",
    "```",
    context.diffStat || "(empty)",
    "```",
    "",
    "### Files",
    "```",
    fileManifest,
    "```",
    "",
    "### Patches",
    patchBlock + truncationNote,
    "",
  ].join("\n");
}

function parseNumStat(numStat: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of numStat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const filename = rest.join("\t");
    if (!filename) continue;
    map.set(filename, {
      additions: a === "-" ? 0 : Number.parseInt(a ?? "0", 10) || 0,
      deletions: d === "-" ? 0 : Number.parseInt(d ?? "0", 10) || 0,
    });
  }
  return map;
}

function parseNameStatus(nameStatus: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const [status, ...rest] = parts;
    const filename = rest[rest.length - 1];
    if (!status || !filename) continue;
    map.set(filename, status);
  }
  return map;
}
