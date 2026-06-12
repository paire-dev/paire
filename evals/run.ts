import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENTS, DEFAULT_FIXTURES, DEFAULT_PAIRE_BIN, gates } from "./config";
import { runClaudeAgent } from "./agents/claude";
import { runCodexAgent } from "./agents/codex";
import { runCursorAgent } from "./agents/cursor";
import { runMockAgent } from "./agents/mock";
import { fixtures } from "./fixtures";
import type { EvalCaseResult, FixtureSpec } from "./harness/types";
import {
  applyFixtureChange,
  createEvalWorkspace,
  extractDraftPath,
  runPaire,
} from "./harness/workspace";
import { objectiveMetrics } from "./metrics/objective";
import { renderScoreboard } from "./report/render";

const args = parseArgs(process.argv.slice(2));
const selectedAgents = splitList(args.agents ?? DEFAULT_AGENTS.join(","));
const selectedFixtures = selectFixtures(args.fixtures ?? DEFAULT_FIXTURES);
const paireBin = args["paire-bin"] ?? DEFAULT_PAIRE_BIN;
const results: EvalCaseResult[] = [];

for (const fixture of selectedFixtures) {
  for (const agent of selectedAgents) {
    results.push(await runCase(fixture, agent, paireBin));
  }
}

const resultDir = join(
  "evals",
  "results",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-local`,
);
mkdirSync(resultDir, { recursive: true });
writeFileSync(join(resultDir, "run.json"), JSON.stringify({ results }, null, 2));
writeFileSync(join(resultDir, "scoreboard.md"), renderScoreboard(results));
writeFileSync(
  join("evals", "results", "history.jsonl"),
  `${JSON.stringify({ ts: new Date().toISOString(), results })}\n`,
  { flag: "a" },
);
console.log(renderScoreboard(results));

if (args.gate === "true" || args.gate === "") {
  enforceGate(results);
}

async function runCase(
  fixture: FixtureSpec,
  agent: string,
  paireBin: string,
) {
  const workspace = await createEvalWorkspace(fixture);
  const start = runPaire(workspace, paireBin, ["start", "--base", "main"]);
  if (start.exitCode !== 0) throw new Error(start.stderr);
  await applyFixtureChange(workspace, fixture);
  const review = runPaire(workspace, paireBin, ["review"]);
  if (review.exitCode !== 0) throw new Error(review.stderr);
  const draftPath = extractDraftPath(review.stdout);
  const started = Date.now();
  const agentResult = await runAgent(agent, {
    repoDir: workspace.repoDir,
    env: workspace.env,
    prompt:
      "Run `paire it` and follow every printed instruction until `paire review --apply` exits 0.",
    draftPath,
    goldReview: fixture.gold.goldReview,
    mode: agent,
    workspace,
    paireBin,
  });
  return await objectiveMetrics({
    fixture: fixture.id,
    agent,
    transcript: agentResult.transcript,
    exitCode: agentResult.exitCode,
    wallClockMs: Date.now() - started,
    draftPath,
    expectedCoveredFiles: fixture.gold.expectedCoveredFiles,
  });
}

function runAgent(
  agent: string,
  input: Parameters<typeof runMockAgent>[0],
) {
  if (agent.startsWith("mock")) return runMockAgent(input);
  if (agent === "claude") return runClaudeAgent(input);
  if (agent === "codex") return runCodexAgent(input);
  if (agent === "cursor") return runCursorAgent(input);
  throw new Error(`Agent adapter not implemented yet: ${agent}`);
}

function enforceGate(results: EvalCaseResult[]) {
  const failures = results.filter((result) => {
    if (result.agent !== "mock") return false;
    return (
      Number(result.firstAttemptApplySuccess) < gates.mock.firstAttemptApplySuccess ||
      result.fileCoverage < gates.mock.fileCoverage
    );
  });
  if (failures.length > 0) {
    console.error(`Eval gate failed for ${failures.length} case(s).`);
    process.exit(1);
  }
}

function selectFixtures(value: string) {
  if (value === "all") return fixtures;
  const ids = new Set(splitList(value));
  return fixtures.filter((fixture) => ids.has(fixture.id));
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
