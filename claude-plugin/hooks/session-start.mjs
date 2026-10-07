// SessionStart hook: one line of context naming what is waiting in attn.
// Reads only the last snapshot (`attn status --json`), so it makes no network
// calls. Prints nothing when attn is missing, fails, or nothing is waiting.
import { spawnSync } from "node:child_process";

const LABELS = {
  pr_review_request: ["review request", "review requests"],
  pr_comment: ["PR comment", "PR comments"],
  issue_assigned: ["assigned issue", "assigned issues"],
  issue_mention: ["mention", "mentions"],
  issue_comment: ["issue comment", "issue comments"],
};

const HOUR_MS = 60 * 60 * 1000;

// The snapshot only moves while the server runs, so say how old it is once
// it is older than a few default poll intervals.
function ageNote(generatedAt, now) {
  const age = now - Date.parse(generatedAt);
  if (!Number.isFinite(age) || age < HOUR_MS) return "";
  const hours = Math.floor(age / HOUR_MS);
  const days = Math.floor(hours / 24);
  const ago = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
  return ` (as of ${ago} ago; is the attn server running?)`;
}

export function contextLine(status, now = Date.now()) {
  if (!status || !Number.isInteger(status.waiting) || status.waiting === 0) return "";
  const parts = Object.entries(LABELS)
    .map(([kind, [one, many]]) => [status.waitingByKind?.[kind] ?? 0, one, many])
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return (
    `attn: ${parts.join(", ")} waiting on ${status.host}${ageNote(status.generatedAt, now)}. ` +
    "Use the attn MCP tools or /attn:triage to work through them."
  );
}

if (import.meta.main) {
  const result = spawnSync("attn", ["status", "--json"], { encoding: "utf8", timeout: 5000 });
  if (result.status === 0) {
    try {
      const line = contextLine(JSON.parse(result.stdout));
      if (line) console.log(line);
    } catch {
      // Malformed output: stay silent rather than break session start.
    }
  }
}
