import { readFileSync } from "node:fs";
import { ExitCode } from "./exit-codes";

export type Primitive = string | number | boolean | null;
export type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue };

export type GlobalOptions = {
  json: boolean;
  yes: boolean;
  answersFile?: string;
  noColor: boolean;
  cwd: string;
};

export type CommandResult = {
  exitCode: ExitCode;
  message?: string;
  data?: JsonValue;
};

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly details?: JsonValue;

  constructor(message: string, exitCode: ExitCode = ExitCode.Generic, details?: JsonValue) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function isTty(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY);
}

export function shouldUseColor(options: Pick<GlobalOptions, "noColor">): boolean {
  return !options.noColor && isTty(process.stdout) && process.env.NO_COLOR === undefined;
}

export function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

export function readAnswersFile(path?: string): Record<string, JsonValue> {
  if (!path) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError("answers file must contain a JSON object", ExitCode.UserError);
    }
    return parsed as Record<string, JsonValue>;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`failed to read answers file: ${path}`, ExitCode.UserError);
  }
}

export function answerString(answers: Record<string, JsonValue>, key: string): string | undefined {
  const value = answers[key];
  return typeof value === "string" ? value : undefined;
}

export function answerBoolean(answers: Record<string, JsonValue>, key: string): boolean | undefined {
  const value = answers[key];
  return typeof value === "boolean" ? value : undefined;
}

export function printResult(result: CommandResult, options: GlobalOptions): void {
  if (options.json) {
    const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : { data: result.data ?? null };
    console.log(JSON.stringify({ ok: result.exitCode === ExitCode.Success, ...data, message: result.message ?? null }, null, 2));
    return;
  }

  if (result.message) console.log(result.message);
}
