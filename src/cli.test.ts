import { expect, test } from "bun:test";

function run(args: string[], input?: string) {
  return Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    stdin: input ? new TextEncoder().encode(input) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("--version exits successfully without prompting", () => {
  const result = run(["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("0.0.1");
});

test("--help exits successfully without prompting", () => {
  const result = run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Stable exit codes");
});

test("commit-msg reads stdin and can emit JSON", () => {
  const result = run(["commit-msg", "--json"], "ship the pipe");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: true, message: "ship the pipe", valid: true });
});

test("impact prints a prompt with PR context and output instructions", () => {
  const result = run(["impact", "--base=main"]);
  expect(result.exitCode).toBe(0);
  const stdout = result.stdout.toString();
  expect(stdout).toContain("# Task: PR impact review");
  expect(stdout).toContain(".paire/impact.md");
  expect(stdout).toContain("<summary>");
  expect(stdout).toContain("Phase 1 — Areas");
  expect(stdout).toContain("Phase 2 — Items per area");
});

test("impact --json emits stable metadata", () => {
  const result = run(["impact", "--base=main", "--json"]);
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout.toString());
  expect(parsed.ok).toBe(true);
  expect(parsed.outputPath).toBe(".paire/impact.md");
  expect(parsed.baseRef).toBe("main");
  expect(typeof parsed.changedFiles).toBe("number");
});
