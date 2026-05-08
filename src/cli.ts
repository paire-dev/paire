#!/usr/bin/env bun
import { initCommand } from "./commands/init";
import { itCommand } from "./commands/it";
import { pushCommand } from "./commands/push";
import { doctorCommand } from "./commands/doctor";
import { commitMsgCommand } from "./commands/commit-msg";
import { ExitCode, exitCodeDescriptions } from "./lib/exit-codes";
import { CliError, printResult, readAnswersFile, type CommandResult, type GlobalOptions, type JsonValue } from "./lib/io";

const VERSION = "0.0.1";

type CommandHandler = (args: string[], options: GlobalOptions, answers: Record<string, JsonValue>) => Promise<CommandResult>;

const commands: Record<string, { summary: string; handler: CommandHandler }> = {
  init: { summary: "Initialize Paire config, hooks, and agent instructions", handler: initCommand },
  it: { summary: "Render a local HTML or Markdown brief", handler: itCommand },
  push: { summary: "Post the generated brief to the current GitHub PR via gh", handler: pushCommand },
  doctor: { summary: "Print environment diagnostics", handler: doctorCommand },
  "commit-msg": { summary: "Read or validate commit message text from stdin or flags", handler: commitMsgCommand },
};

async function main(argv: string[]): Promise<number> {
  const parsed = parseGlobal(argv);
  if (parsed.help) {
    console.log(helpText());
    return ExitCode.Success;
  }
  if (parsed.version) {
    console.log(VERSION);
    return ExitCode.Success;
  }

  const commandName = parsed.command ?? "help";
  if (commandName === "help") {
    console.log(helpText());
    return ExitCode.Success;
  }

  const command = commands[commandName];
  if (!command) {
    throw new CliError(`unknown command: ${commandName}`, ExitCode.UserError);
  }

  const options: GlobalOptions = {
    json: parsed.globalArgs.includes("--json"),
    yes: parsed.globalArgs.includes("-y") || parsed.globalArgs.includes("--yes"),
    answersFile: getFlagValue(parsed.globalArgs, "answers-file"),
    noColor: parsed.globalArgs.includes("--no-color") || !process.stdout.isTTY,
    cwd: process.cwd(),
  };
  const answers = readAnswersFile(options.answersFile);
  const result = await command.handler(parsed.commandArgs, options, answers);
  printResult(result, options);
  return result.exitCode;
}

function parseGlobal(argv: string[]): { command?: string; commandArgs: string[]; globalArgs: string[]; help: boolean; version: boolean } {
  const globalArgs: string[] = [];
  let command: string | undefined;
  const commandArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (isGlobalFlag(arg)) {
      globalArgs.push(arg);
      if ((arg === "--answers-file") && argv[index + 1]) {
        index += 1;
        globalArgs.push(argv[index] as string);
      }
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    commandArgs.push(arg);
  }

  return {
    command,
    commandArgs,
    globalArgs,
    help: globalArgs.includes("--help") || globalArgs.includes("-h"),
    version: globalArgs.includes("--version") || globalArgs.includes("-v"),
  };
}

function isGlobalFlag(arg: string): boolean {
  return ["--json", "-y", "--yes", "--help", "-h", "--version", "-v", "--no-color", "--answers-file"].includes(arg) || arg.startsWith("--answers-file=");
}

function getFlagValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function helpText(): string {
  const commandRows = Object.entries(commands).map(([name, command]) => `  ${name.padEnd(12)} ${command.summary}`).join("\n");
  const exits = Object.entries(exitCodeDescriptions).map(([code, description]) => `  ${code}  ${description}`).join("\n");

  return `paire ${VERSION}

Usage:
  paire [global flags] <command> [command flags]

Global flags:
  --json                         Print machine-readable JSON on every command
  -y, --yes                      Accept safe defaults for prompts
  --answers-file <path.json>     Read prompt answers from a JSON object
  --no-color                     Disable ANSI color output
  -h, --help                     Print help and exit 0 without prompting
  -v, --version                  Print version and exit 0 without prompting

Commands:
${commandRows}

Stable exit codes:
${exits}
`;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  const cliError = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
  const json = process.argv.includes("--json");
  if (json) {
    console.error(JSON.stringify({ ok: false, message: cliError.message, details: cliError.details }, null, 2));
  } else {
    console.error(cliError.message);
  }
  process.exitCode = cliError.exitCode;
});
