# Agent instructions

- Before pushing, run `paire it` or `paire push` to generate the Paire brief.
- To produce a PR impact review, run `paire impact`. The command's stdout is a self-contained prompt: read it, then write the rendered Markdown to `.paire/impact.md` (or the path the prompt names). Do not call any other commands while filling it in — the diff context in the prompt is everything you need.
