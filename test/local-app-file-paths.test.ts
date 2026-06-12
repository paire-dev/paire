import { expect, test } from "bun:test";

import {
  filePathsMatch,
  normalizeFilePath,
  resolveFilePathMatch,
} from "../src/local-app/file-paths";

test("normalizes relative and windows-style file paths", () => {
  expect(normalizeFilePath("./src\\local-app\\main.tsx")).toBe(
    "src/local-app/main.tsx",
  );
});

test("matches exact paths and directory suffixes", () => {
  expect(filePathsMatch("src/local-app/main.tsx", "src/local-app/main.tsx")).toBe(
    true,
  );
  expect(filePathsMatch("packages/app/src/main.tsx", "src/main.tsx")).toBe(true);
  expect(filePathsMatch("src/main.tsx", "packages/app/src/main.tsx")).toBe(true);
});

test("does not match files by basename alone", () => {
  expect(filePathsMatch("src/page.tsx", "app/page.tsx")).toBe(false);
  expect(filePathsMatch("src/local-app/main.tsx", "src/cli/main.tsx")).toBe(
    false,
  );
});

test("resolves exact path matches before suffix matches", () => {
  const files = [
    { path: "apps/platform/app/(ai-app)/(platform)/(content)/templates/page.tsx" },
    {
      path: "apps/platform/app/(ai-app)/(platform)/(content)/visualizations/page.tsx",
    },
  ];

  expect(
    resolveFilePathMatch(
      files,
      "apps/platform/app/(ai-app)/(platform)/(content)/visualizations/page.tsx",
      (file) => [file.path],
    ),
  ).toBe(files[1]);
});

test("rejects ambiguous suffix matches", () => {
  const files = [
    { path: "apps/platform/app/(ai-app)/(platform)/(content)/templates/page.tsx" },
    {
      path: "apps/platform/app/(ai-app)/(platform)/(content)/visualizations/page.tsx",
    },
  ];

  expect(resolveFilePathMatch(files, "page.tsx", (file) => [file.path])).toBe(
    undefined,
  );
});
