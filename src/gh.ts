import { spawn } from "node:child_process";
import type { Config } from "./types";

const READ_COMMANDS = new Set(["auth status", "search prs", "search issues", "pr view", "issue view", "api"]);

function commandKey(args: string[]): string {
  if (args[0] === "api") return "api";
  return `${args[0] || ""} ${args[1] || ""}`.trim();
}

// The letters of a short-flag token, or undefined for long flags / operands.
// gh uses pflag, which lets short flags cluster in one token: -iXPOST is -i
// (include) + -X POST. A per-token equality check misses a flag smuggled inside
// a cluster, so method/field detection inspects these letters.
function shortFlagLetters(arg: string): string | undefined {
  return arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1 ? arg.slice(1) : undefined;
}

// `gh api` defaults to POST as soon as any field/body flag is present, and
// `gh api graphql` can carry mutations — neither sets -X. So enforcing "GET
// only" means rejecting those, not just an explicit non-GET --method.
function isApiWriteFlag(arg: string): boolean {
  if (arg === "--field" || arg === "--raw-field" || arg === "--input") return true;
  if (arg.startsWith("--field=") || arg.startsWith("--raw-field=") || arg.startsWith("--input=")) return true;
  // -f / -F (field / field-raw) anywhere in a short-flag cluster forces a write.
  const letters = shortFlagLetters(arg);
  return letters !== undefined && /[fF]/.test(letters);
}

function apiMethod(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--method") return args[i + 1]?.toUpperCase();
    if (arg.startsWith("--method=")) return arg.slice("--method=".length).toUpperCase();
    // -X in any short cluster: the value is the rest of the token (-iXPOST) or
    // the following arg (-iX POST).
    const letters = shortFlagLetters(arg);
    const x = letters?.indexOf("X") ?? -1;
    if (letters !== undefined && x !== -1) {
      const rest = letters.slice(x + 1);
      return (rest || args[i + 1])?.toUpperCase();
    }
  }
  return undefined;
}

export function assertReadOnlyGhArgs(args: string[]): void {
  const key = commandKey(args);
  if (!READ_COMMANDS.has(key)) {
    throw new Error(`Rejected non-allowlisted gh command: gh ${args.join(" ")}`);
  }

  if (args[0] === "api") {
    if (args.includes("graphql")) {
      throw new Error("Rejected gh api graphql call: only REST GET requests are allowed.");
    }
    const writeFlag = args.find(isApiWriteFlag);
    if (writeFlag) {
      throw new Error(`Rejected gh api field flag that forces a write request: ${writeFlag}`);
    }
    const method = apiMethod(args);
    if (method && method !== "GET") {
      throw new Error(`Rejected non-GET gh api call: ${method}`);
    }
  }

  const forbidden = new Set(["merge", "review", "edit", "close", "reopen", "comment", "create", "delete"]);
  for (const arg of args) {
    if (forbidden.has(arg)) {
      throw new Error(`Rejected mutating gh argument: ${arg}`);
    }
  }
}

export async function runGhJson<T>(config: Config, args: string[]): Promise<T> {
  assertReadOnlyGhArgs(args);
  const env = { ...process.env, GH_HOST: config.host };
  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolve, reject) => {
    const proc = spawn("gh", args, { env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });

  if (exitCode !== 0) throw new Error((stderr || stdout || `gh exited ${exitCode}`).trim());

  return JSON.parse(stdout || "null") as T;
}
