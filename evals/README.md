# Paire Evals

Local eval runner for the real `paire it` review flow.

Offline mock run:

```sh
bun evals/run.ts --agents mock --fixtures all
```

Failure-injection examples:

```sh
bun evals/run.ts --agents mock:omit-file --fixtures multi-area
bun evals/run.ts --agents mock:bad-importance --fixtures single-area
```

Outputs are written to `evals/results/<timestamp>-local/run.json` and `scoreboard.md`.

Real agent and judge adapters are intentionally isolated from the root CLI. Judge/probe work should use `AI_GATEWAY_API_KEY`; external agent CLIs use their own provider keys.
