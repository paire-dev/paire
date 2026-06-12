import type { EvalCaseResult } from "../harness/types";

export function renderScoreboard(results: EvalCaseResult[]) {
  const lines = [
    "# Paire Eval Scoreboard",
    "",
    "| fixture | agent | apply 1st-try | attempts | wall s | coverage | ack rate | claims | errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of results) {
    lines.push(
      [
        `| ${result.fixture}`,
        result.agent,
        result.firstAttemptApplySuccess ? "yes" : "no",
        String(result.applyAttempts),
        (result.wallClockMs / 1000).toFixed(2),
        result.fileCoverage.toFixed(2),
        result.acknowledgeRate.toFixed(2),
        String(result.claimCount),
        String(result.schemaErrorCount),
      ].join(" | ") + " |",
    );
  }
  return `${lines.join("\n")}\n`;
}
