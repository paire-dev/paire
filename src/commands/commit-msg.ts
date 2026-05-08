import { readStdinIfPiped, type CommandResult, type GlobalOptions } from "../lib/io";
import { ExitCode } from "../lib/exit-codes";

export async function commitMsgCommand(args: string[], _options: GlobalOptions): Promise<CommandResult> {
  const stdin = (await readStdinIfPiped())?.trim();
  const message = getFlagValue(args, "message") ?? stdin ?? "";
  if (!message) {
    return { exitCode: ExitCode.UserError, message: "commit message is required", data: { valid: false } };
  }

  return {
    exitCode: ExitCode.Success,
    message,
    data: { message, valid: true },
  };
}

function getFlagValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
