// Dependabot appears as "dependabot[bot]" (or "app/dependabot" in some search
// payloads); dependency PRs raised by other automation are recognised by the
// conventional "dependencies" label instead.
const DEPENDENCY_LABELS = new Set(["dependencies"]);

export function isDependencyBotItem(item: { actor: string; labels: string[] }): boolean {
  const actor = item.actor.toLowerCase();
  return (
    actor === "dependabot" ||
    actor.startsWith("dependabot[") ||
    actor === "app/dependabot" ||
    item.labels.some((label) => DEPENDENCY_LABELS.has(label.toLowerCase()))
  );
}
