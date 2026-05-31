import { currentBranch, diff, recentCommits } from "../lib/git";

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type Brief = {
  title: string;
  branch: string;
  diffStat: string;
  commits: string;
  generatedAt: string;
};

export async function createBrief(cwd: string, baseBranch?: string): Promise<Brief> {
  const [branch, diffStat, commits] = await Promise.all([
    currentBranch(cwd),
    diff(cwd, baseBranch).catch(() => ""),
    recentCommits(cwd).catch(() => ""),
  ]);

  return {
    title: `Paire brief for ${branch || "detached HEAD"}`,
    branch,
    diffStat,
    commits,
    generatedAt: new Date().toISOString(),
  };
}

export function renderMarkdown(brief: Brief): string {
  return [
    `# ${brief.title}`,
    "",
    `Generated: ${brief.generatedAt}`,
    "",
    "## Diff stat",
    "",
    brief.diffStat ? `\`\`\`\n${brief.diffStat}\n\`\`\`` : "No working-tree diff detected.",
    "",
    "## Recent commits",
    "",
    brief.commits ? `\`\`\`\n${brief.commits}\n\`\`\`` : "No commits found.",
    "",
  ].join("\n");
}

export function renderHtml(brief: Brief): string {
  const markdown = renderMarkdown(brief);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(brief.title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 860px; padding: 0 1rem; line-height: 1.5; }
    pre { background: #111827; color: #f9fafb; padding: 1rem; overflow-x: auto; border-radius: 0.5rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <pre>${escapeHTML(markdown)}</pre>
  </main>
</body>
</html>
`;
}
