export interface Summarizable {
  title: string;
  body?: string;
}

export function summarize(item: Summarizable): string {
  const body = (item.body || "").replace(/\s+/g, " ").trim();
  if (body) {
    const firstSentence = body.split(/(?<=[.!?])\s+/, 1)[0];
    if (firstSentence.length >= 24 && firstSentence.length <= 260) return firstSentence;
  }
  return item.title.endsWith(".") ? item.title : `${item.title}.`;
}
