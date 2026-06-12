import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { PAIRE_VERSION } from "./version";

export const PAIRE_REPO = "paire-dev/paire";

const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/paire-dev/paire/main/scripts/install.sh";

/** Command users can copy/paste to upgrade. */
export const PAIRE_UPGRADE_HINT = "paire upgrade";

/** Pipeline run by `paire upgrade` to reinstall the latest release. */
export const PAIRE_INSTALL_PIPELINE = `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`;

/** How long a cached upgrade check stays fresh before we hit the network again. */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Compare two semver-ish version strings (a leading "v" is ignored).
 * Returns 1 if `a` is newer, -1 if `b` is newer, 0 if equal or incomparable.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * Whether `latest` is a newer release than `current`. Dev builds never report
 * an available upgrade. Narrows `latest` to a string so callers can use it.
 */
export function upgradeAvailable(
  current: string,
  latest: string | null,
): latest is string {
  if (!latest) return false;
  if (current === "dev") return false;
  return compareVersions(latest, current) > 0;
}

/** Human-facing notice printed when a newer release exists. */
export function upgradeNotice(latest: string, current = PAIRE_VERSION): string {
  return [
    `A new version of paire is available: ${latest} (current ${current}).`,
    `Upgrade with: ${PAIRE_UPGRADE_HINT}`,
  ].join("\n");
}

function repoFromEnv(env?: Record<string, string | undefined>): string {
  const repo = env?.PAIRE_REPO?.trim();
  return repo && repo.length > 0 ? repo : PAIRE_REPO;
}

/**
 * Fetch the latest release tag from the GitHub API. Returns null on any error
 * (offline, rate limited, timeout) so callers can degrade gracefully.
 */
export async function fetchLatestVersion(
  options: {
    repo?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const repo = options.repo ?? repoFromEnv(options.env);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "paire-cli",
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
    return tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
}

type UpgradeCache = { checkedAt: number; latest: string | null };

function readCache(cachePath: string): UpgradeCache | null {
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as UpgradeCache;
    if (typeof parsed.checkedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Return the latest release tag, reusing a recent on-disk check when possible
 * so repeated `paire it` runs don't hammer the GitHub API (60 req/hr
 * unauthenticated). Refreshes and rewrites the cache when stale.
 */
export async function getLatestVersionCached(options: {
  cachePath: string;
  env?: Record<string, string | undefined>;
  ttlMs?: number;
  now?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = readCache(options.cachePath);
  if (cached && now - cached.checkedAt < ttl) {
    return cached.latest;
  }
  const latest = await fetchLatestVersion({
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  try {
    writeFileSync(
      options.cachePath,
      JSON.stringify({ checkedAt: now, latest } satisfies UpgradeCache),
    );
  } catch {
    // A failed cache write is non-fatal; we simply re-check next time.
  }
  return latest;
}
