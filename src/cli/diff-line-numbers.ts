export type ParsedDiffLine = {
  kind: "added" | "removed" | "unchanged";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function annotateHunkText(
  hunkText: string,
  additionStart: number,
  deletionStart: number,
): { annotatedText: string; lines: ParsedDiffLine[] } {
  const rawLines = hunkText.split(/\r?\n/);
  const parsed: ParsedDiffLine[] = [];
  let oldLine = deletionStart;
  let newLine = additionStart;
  let inHunk = false;
  let maxNewLine = additionStart;

  for (const line of rawLines) {
    if (line.match(HUNK_HEADER)) {
      oldLine = deletionStart;
      newLine = additionStart;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("\\")) continue;

    const prefix = line[0];
    const body = line.slice(1);

    if (prefix === "+" && !line.startsWith("+++")) {
      parsed.push({
        kind: "added",
        content: body,
        oldLine: null,
        newLine,
      });
      maxNewLine = Math.max(maxNewLine, newLine);
      newLine += 1;
      continue;
    }

    if (prefix === "-" && !line.startsWith("---")) {
      parsed.push({
        kind: "removed",
        content: body,
        oldLine,
        newLine: null,
      });
      oldLine += 1;
      continue;
    }

    if (prefix === " ") {
      parsed.push({
        kind: "unchanged",
        content: body,
        oldLine,
        newLine,
      });
      maxNewLine = Math.max(maxNewLine, newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  const width = Math.max(4, String(maxNewLine).length);
  const formatted: string[] = [];
  let parsedIndex = 0;

  for (const line of rawLines) {
    if (line.match(HUNK_HEADER)) {
      formatted.push(line);
      continue;
    }

    if (line.startsWith("\\")) {
      formatted.push(line);
      continue;
    }

    const prefix = line[0];
    const body = line.slice(1);
    const entry = parsed[parsedIndex];

    if (prefix === "+" && !line.startsWith("+++")) {
      formatted.push(
        `${String(entry?.newLine ?? "").padStart(width)}|+${body}`,
      );
      parsedIndex += 1;
      continue;
    }

    if (prefix === "-" && !line.startsWith("---")) {
      formatted.push(`${"".padStart(width)}|-${body}`);
      parsedIndex += 1;
      continue;
    }

    if (prefix === " ") {
      formatted.push(
        `${String(entry?.newLine ?? "").padStart(width)}| ${body}`,
      );
      parsedIndex += 1;
      continue;
    }

    if (line.length > 0) formatted.push(line);
  }

  return {
    annotatedText: formatted.join("\n"),
    lines: parsed,
  };
}

export function addedLineRanges(lines: ParsedDiffLine[]) {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  for (const line of lines) {
    if (line.kind !== "added" || line.newLine == null) continue;
    const last = ranges.at(-1);
    if (last && line.newLine === last.endLine + 1) {
      last.endLine = line.newLine;
      continue;
    }
    ranges.push({ startLine: line.newLine, endLine: line.newLine });
  }
  return ranges;
}
