import type { AgentRunInput, AgentRunResult, GoldReview } from "../harness/types";
import { runPaire, type EvalWorkspace } from "../harness/workspace";

export async function runMockAgent(
  input: AgentRunInput & { workspace: EvalWorkspace; paireBin: string },
): Promise<AgentRunResult> {
  const started = Date.now();
  const draft = await Bun.file(input.draftPath).json();
  const review = mutateGoldReview(input.goldReview, input.mode);
  const payload = {
    ...draft,
    threads: review.threads,
  };
  await Bun.write(input.draftPath, JSON.stringify(payload, null, 2));
  const apply = runPaire(input.workspace, input.paireBin, [
    "review",
    "--apply",
    input.draftPath,
    "--no-open",
  ]);
  return {
    transcript: [apply.stdout, apply.stderr].filter(Boolean).join("\n"),
    exitCode: apply.exitCode,
    wallMs: Date.now() - started,
  };
}

function mutateGoldReview(goldReview: GoldReview, mode: string): GoldReview {
  if (mode === "mock:omit-file") {
    return {
      threads: goldReview.threads.map((thread, index) =>
        index === 0
          ? { ...thread, claims: thread.claims.slice(0, 1) }
          : thread,
      ),
    };
  }
  if (mode === "mock:bad-importance") {
    return {
      threads: goldReview.threads.map((thread) => ({
        ...thread,
        claims: thread.claims.map((claim, index) =>
          index === 0
            ? { ...claim, importance: "urgent" }
            : claim,
        ),
      })),
    };
  }
  return goldReview;
}
