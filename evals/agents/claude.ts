import type { AgentRunInput, AgentRunResult } from "../harness/types";

export async function runClaudeAgent(input: AgentRunInput): Promise<AgentRunResult> {
  return runCliAgent({
    command: [
      "claude",
      "-p",
      input.prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--max-turns",
      "40",
    ],
    cwd: input.repoDir,
    env: input.env,
  });
}

function runCliAgent(options: {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}): AgentRunResult {
  const started = Date.now();
  const result = Bun.spawnSync(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15 * 60 * 1000,
  });
  return {
    transcript: `${text(result.stdout)}\n${text(result.stderr)}`.trim(),
    exitCode: result.exitCode,
    wallMs: Date.now() - started,
  };
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}
