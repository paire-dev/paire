import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

export const supportedHooks = ["pre-commit", "pre-push"] as const;
export type SupportedHook = (typeof supportedHooks)[number];

export function parseHooks(value: string | undefined): SupportedHook[] {
  if (!value) return [];
  const hooks = value.split(",").map((hook) => hook.trim()).filter(Boolean);
  const invalid = hooks.filter((hook) => !supportedHooks.includes(hook as SupportedHook));
  if (invalid.length > 0) {
    throw new CliError(`unsupported hook(s): ${invalid.join(", ")}`, ExitCode.UserError);
  }
  return hooks as SupportedHook[];
}

export function installHooks(cwd: string, hooks: SupportedHook[]): string[] {
  return hooks.map((hook) => {
    const path = join(cwd, ".git", "hooks", hook);
    mkdirSync(dirname(path), { recursive: true });
    const command = hook === "pre-push" ? "paire push --json" : "paire it --json --no-open";
    writeFileSync(path, `#!/bin/sh\nset -eu\n${command}\n`);
    chmodSync(path, 0o755);
    return path;
  });
}
