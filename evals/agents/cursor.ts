import type { AgentRunInput, AgentRunResult } from "../harness/types";

export async function runCursorAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const started = Date.now();
  const result = Bun.spawnSync(
    ["cursor-agent", "-p", input.prompt, "--force", "--output-format", "text"],
    {
      cwd: input.repoDir,
      env: input.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    transcript: `${text(result.stdout)}\n${text(result.stderr)}`.trim(),
    exitCode: result.exitCode,
    wallMs: Date.now() - started,
  };
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}
