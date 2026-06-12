import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareVersions,
  getLatestVersionCached,
  upgradeAvailable,
  upgradeNotice,
} from "../src/cli/upgrade";

test("compareVersions orders semver-ish strings and ignores leading v", () => {
  expect(compareVersions("v1.2.0", "1.1.9")).toBe(1);
  expect(compareVersions("1.0.0", "v1.0.1")).toBe(-1);
  expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
});

test("upgradeAvailable is false for dev builds and non-newer releases", () => {
  expect(upgradeAvailable("dev", "v9.9.9")).toBe(false);
  expect(upgradeAvailable("v1.0.0", null)).toBe(false);
  expect(upgradeAvailable("v1.0.0", "v1.0.0")).toBe(false);
  expect(upgradeAvailable("v1.0.0", "v1.0.1")).toBe(true);
});

test("upgradeNotice mentions the new version and the upgrade command", () => {
  const notice = upgradeNotice("v1.2.0", "v1.0.0");
  expect(notice).toContain("v1.2.0");
  expect(notice).toContain("v1.0.0");
  expect(notice).toContain("paire upgrade");
});

test("getLatestVersionCached reuses a fresh cache without hitting the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paire-upgrade-"));
  try {
    const cachePath = join(dir, "upgrade-check.json");
    const now = 1_000_000;
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: now, latest: "v3.0.0" }),
    );
    const latest = await getLatestVersionCached({
      cachePath,
      ttlMs: 60_000,
      now: now + 30_000,
    });
    expect(latest).toBe("v3.0.0");
    // Cache file is untouched when fresh.
    const stored = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(stored.checkedAt).toBe(now);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
