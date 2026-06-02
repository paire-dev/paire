import { expect, test } from "bun:test";

import {
  addedLineRanges,
  annotateHunkText,
} from "../src/cli/diff-line-numbers";

test("annotateHunkText prefixes new-file line numbers", () => {
  const hunk = `@@ -4,3 +4,5 @@ export function validateWorkspace(input: { name?: string }) {
   }
   return input.name.trim();
 }
+
+export const workspaceValidationVersion = 2;`;

  const { annotatedText, lines } = annotateHunkText(hunk, 4, 4);

  expect(annotatedText).toBe(`@@ -4,3 +4,5 @@ export function validateWorkspace(input: { name?: string }) {
   4|   }
   5|   return input.name.trim();
   6| }
   7|+
   8|+export const workspaceValidationVersion = 2;`);
  expect(lines).toEqual([
    { kind: "unchanged", content: "  }", oldLine: 4, newLine: 4 },
    {
      kind: "unchanged",
      content: "  return input.name.trim();",
      oldLine: 5,
      newLine: 5,
    },
    { kind: "unchanged", content: "}", oldLine: 6, newLine: 6 },
    { kind: "added", content: "", oldLine: null, newLine: 7 },
    {
      kind: "added",
      content: "export const workspaceValidationVersion = 2;",
      oldLine: null,
      newLine: 8,
    },
  ]);
});

test("deletions do not advance the new-file counter", () => {
  const hunk = `@@ -10,4 +10,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 return a + b`;

  const { annotatedText, lines } = annotateHunkText(hunk, 10, 10);

  expect(annotatedText).toContain("  10| const a = 1");
  expect(annotatedText).toContain("    |-const b = 2");
  expect(annotatedText).toContain("  11|+const b = 3");
  expect(annotatedText).toContain("  12|+const c = 4");
  expect(annotatedText).toContain("  13| return a + b");
  expect(lines.map((line) => line.newLine)).toEqual([
    10,
    null,
    11,
    12,
    13,
  ]);
});

test("addedLineRanges groups contiguous added lines", () => {
  const hunk = `@@ -10,4 +10,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 return a + b`;

  const { lines } = annotateHunkText(hunk, 10, 10);
  expect(addedLineRanges(lines)).toEqual([{ startLine: 11, endLine: 12 }]);
});

test("addedLineRanges splits non-contiguous added lines", () => {
  const hunk = `@@ -4,3 +4,5 @@ export function validateWorkspace(input: { name?: string }) {
   }
   return input.name.trim();
 }
+
+export const workspaceValidationVersion = 2;`;

  const { lines } = annotateHunkText(hunk, 4, 4);
  expect(addedLineRanges(lines)).toEqual([{ startLine: 7, endLine: 8 }]);
});
