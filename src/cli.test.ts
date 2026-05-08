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
