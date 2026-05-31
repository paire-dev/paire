#!/usr/bin/env bun
import { runCli } from "./cli/local-engine";

const exitCode = await runCli(Bun.argv.slice(2));
process.exit(exitCode);
