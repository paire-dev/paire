import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FixtureSpec, GoldReview } from "../harness/types";

export const fixtures: FixtureSpec[] = [
  {
    id: "single-area",
    setup: baseApp,
    change: async (repo) => {
      await write(join(repo, "src/app.ts"), [
        "export function createProject(user: { id: string } | null) {",
        "  if (!user) throw new Error('Unauthorized');",
        "  return { ownerId: user.id };",
        "}",
        "",
      ]);
    },
    gold: {
      expectedCoveredFiles: ["src/app.ts"],
      maxClaims: 1,
      goldReview: review("thread_auth", "Auth validation", [
        claim("claim_auth_required", "thread_auth", "Reject missing users before create", "important", "src/app.ts", 1, 4),
      ]),
    },
  },
  {
    id: "multi-area",
    setup: baseApp,
    change: async (repo) => {
      await write(join(repo, "src/app.ts"), [
        "export function createProject(user: { id: string } | null, name: string) {",
        "  if (!user) throw new Error('Unauthorized');",
        "  return { ownerId: user.id, name };",
        "}",
        "",
      ]);
      await write(join(repo, "src/workspace.ts"), [
        "export function validateWorkspace(input: { name?: string }) {",
        "  if (!input.name) throw new Error('Missing workspace name');",
        "  return input.name.trim();",
        "}",
        "",
      ]);
      await write(join(repo, "config/review.json"), "{ \"requireWorkspace\": true }\n");
    },
    gold: {
      expectedCoveredFiles: ["src/app.ts", "src/workspace.ts", "config/review.json"],
      goldReview: review("thread_validation", "Input validation", [
        claim("claim_auth_required", "thread_validation", "Reject missing users before create", "important", "src/app.ts", 1, 4),
        claim("claim_workspace_required", "thread_validation", "Reject workspaces without names", "important", "src/workspace.ts", 1, 4),
        claim("claim_config_requires_workspace", "thread_validation", "Enable required workspace validation", "minor", "config/review.json", 1, 1),
      ]),
    },
  },
  {
    id: "refactor-rename",
    setup: baseApp,
    change: async (repo) => {
      await write(join(repo, "src/project.ts"), [
        "export function buildProjectName(name: string) {",
        "  return name.trim();",
        "}",
        "",
      ]);
      await write(join(repo, "src/app.ts"), [
        "import { buildProjectName } from './project';",
        "export function createProject(name: string) {",
        "  return { name: buildProjectName(name) };",
        "}",
        "",
      ]);
    },
    gold: {
      expectedCoveredFiles: ["src/app.ts", "src/project.ts"],
      maxClaims: 2,
      goldReview: review("thread_refactor", "Project naming refactor", [
        claim("claim_project_name_helper", "thread_refactor", "Move project name trimming into helper", "noise", "src/project.ts", 1, 3),
        claim("claim_app_uses_helper", "thread_refactor", "Call project name helper from create", "noise", "src/app.ts", 1, 4),
      ]),
    },
  },
  {
    id: "incremental-revision",
    setup: baseApp,
    change: async (repo) => {
      await write(join(repo, "src/app.ts"), [
        "export function createProject(user: { id: string } | null) {",
        "  if (!user) throw new Error('Unauthorized');",
        "  return { ownerId: user.id };",
        "}",
        "",
      ]);
    },
    change2: async (repo) => {
      await write(join(repo, "src/app.ts"), [
        "export function createProject(user: { id: string } | null) {",
        "  if (!user) throw new Error('Unauthorized');",
        "  return { ownerId: user.id, audited: true };",
        "}",
        "",
      ]);
    },
    gold: {
      expectedCoveredFiles: ["src/app.ts"],
      expectedUnchanged: ["claim_auth_required"],
      goldReview: review("thread_auth", "Auth validation", [
        claim("claim_auth_required", "thread_auth", "Reject missing users before create", "important", "src/app.ts", 1, 4),
      ]),
    },
  },
  {
    id: "lockfile-noise",
    setup: baseApp,
    change: async (repo) => {
      await write(join(repo, "src/app.ts"), [
        "export function createProject(name: string) {",
        "  return { name: name.trim() };",
        "}",
        "",
      ]);
      await write(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: largeLockPackages() }, null, 2));
    },
    gold: {
      expectedCoveredFiles: ["src/app.ts", "package-lock.json"],
      goldReview: review("thread_project_name", "Project name normalization", [
        claim("claim_trim_project_name", "thread_project_name", "Trim project names before create", "minor", "src/app.ts", 1, 3),
      ]),
    },
  },
  {
    id: "buried-behavior-change",
    setup: async (repo) => {
      await write(join(repo, "src/limits.ts"), [
        "export function withinLimit(count: number, limit: number) {",
        "  return count <= limit;",
        "}",
        "",
      ]);
    },
    change: async (repo) => {
      await write(join(repo, "src/limits.ts"), [
        "export function withinLimit(currentCount: number, maxCount: number) {",
        "  return currentCount < maxCount;",
        "}",
        "",
      ]);
    },
    gold: {
      expectedCoveredFiles: ["src/limits.ts"],
      goldReview: review("thread_limits", "Limit boundary behavior", [
        claim("claim_limit_excludes_equal", "thread_limits", "Reject counts equal to the limit", "critical", "src/limits.ts", 1, 3),
      ]),
    },
  },
  {
    id: "security-critical",
    setup: async (repo) => {
      await write(join(repo, "src/server.ts"), [
        "export function corsOrigin(origin: string) {",
        "  if (!origin.endsWith('.example.com')) throw new Error('Forbidden');",
        "  return origin;",
        "}",
        "",
      ]);
    },
    change: async (repo) => {
      await write(join(repo, "src/server.ts"), [
        "export function corsOrigin(origin: string) {",
        "  return '*';",
        "}",
        "",
      ]);
    },
    gold: {
      expectedCoveredFiles: ["src/server.ts"],
      goldReview: review("thread_cors", "CORS security", [
        claim("claim_cors_allows_any_origin", "thread_cors", "Allow any CORS origin", "critical", "src/server.ts", 1, 3),
      ]),
    },
  },
];

async function baseApp(repo: string) {
  await write(join(repo, "src/app.ts"), [
    "export function createProject(name: string) {",
    "  return { name };",
    "}",
    "",
  ]);
  await write(join(repo, "package-lock.json"), "{}\n");
}

function review(threadId: string, title: string, claims: GoldReview["threads"][number]["claims"]): GoldReview {
  return { threads: [{ id: threadId, title, claims }] };
}

function claim(
  id: string,
  threadId: string,
  title: string,
  importance: "critical" | "important" | "minor" | "noise",
  filePath: string,
  startLine: number,
  endLine: number,
) {
  return {
    id,
    threadId,
    title,
    agentStatus: "new" as const,
    importance,
    evidences: [{ filePath, startLine, endLine, change: title }],
    before: "The behavior was absent before this change.",
    after: title,
  };
}

async function write(path: string, contents: string | string[]) {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, Array.isArray(contents) ? contents.join("\n") : contents);
}

function largeLockPackages() {
  return Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => [
      `node_modules/package-${index}`,
      { version: `1.0.${index}`, resolved: `https://example.com/${index}` },
    ]),
  );
}
