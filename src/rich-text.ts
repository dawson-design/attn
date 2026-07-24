const ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr"]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSafeHref(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:")
  );
}

export function sanitizeHtml(input: string): string {
  const withoutDangerousBlocks = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const tagPattern = /<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let output = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(withoutDangerousBlocks))) {
    output += escapeHtml(withoutDangerousBlocks.slice(lastIndex, match.index));
    lastIndex = tagPattern.lastIndex;

    const raw = match[0];
    const tag = match[1].toLowerCase();
    const isClosing = raw.startsWith("</");
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (isClosing) {
      if (!VOID_TAGS.has(tag)) output += `</${tag}>`;
      continue;
    }

    if (tag === "a") {
      const href = match[2].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
      const value = href?.[1] || href?.[2] || href?.[3] || "";
      output += isSafeHref(value) ? `<a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">` : "<a>";
      continue;
    }

    output += `<${tag}>`;
  }

  output += escapeHtml(withoutDangerousBlocks.slice(lastIndex));
  return output;
}

interface RenderedMarkdown {
  html: string;
  codeBlocks: string[];
  inlineCodes: string[];
}

function renderInlineMarkdown(value: string, inlineCodes: string[]): string {
  let output = value;
  output = output.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlineCodes.push(code) - 1;
    return `§§INLINE_CODE_${index}§§`;
  });
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    return isSafeHref(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>` : label;
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return output;
}

function isBlockHtml(value: string): boolean {
  return /^<\/?(blockquote|h[1-6]|hr|ol|p|pre|ul)\b/i.test(value.trim());
}

function renderMarkdown(input: string): RenderedMarkdown {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | undefined;
  let quote: string[] = [];
  let code: string[] | undefined;

  function flushParagraph(): void {
    if (!paragraph.length) return;
    const text = paragraph.join(" ");
    blocks.push(
      isBlockHtml(text) ? renderInlineMarkdown(text, inlineCodes) : `<p>${renderInlineMarkdown(text, inlineCodes)}</p>`,
    );
    paragraph = [];
  }

  function flushList(): void {
    if (!list) return;
    blocks.push(
      `<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item, inlineCodes)}</li>`).join("")}</${list.type}>`,
    );
    list = undefined;
  }

  function flushQuote(): void {
    if (!quote.length) return;
    blocks.push(`<blockquote>${renderInlineMarkdown(quote.join(" "), inlineCodes)}</blockquote>`);
    quote = [];
  }

  function flushCode(): void {
    if (!code) return;
    const index = codeBlocks.push(code.join("\n")) - 1;
    blocks.push(`§§CODE_BLOCK_${index}§§`);
    code = undefined;
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) flushCode();
      else {
        flushParagraph();
        flushList();
        flushQuote();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2], inlineCodes)}</h${heading[1].length}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = unordered ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push((unordered || ordered)?.[1] || "");
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.+)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();
  flushList();
  flushQuote();
  return { html: blocks.join("\n"), codeBlocks, inlineCodes };
}

export function renderRichText(input: string): string {
  if (!input.trim()) return "";
  const markdown = renderMarkdown(input);
  let html = sanitizeHtml(markdown.html);
  // Function replacements, not string replacements: a code span containing
  // `$&`, `` $` `` or `$'` would otherwise be interpreted as a replacement
  // pattern and splice document text into the output, corrupting the render.
  for (const [index, code] of markdown.inlineCodes.entries()) {
    html = html.replaceAll(`§§INLINE_CODE_${index}§§`, () => `<code>${escapeHtml(code)}</code>`);
  }
  for (const [index, code] of markdown.codeBlocks.entries()) {
    html = html.replaceAll(`§§CODE_BLOCK_${index}§§`, () => `<pre><code>${escapeHtml(code)}</code></pre>`);
  }
  return html;
}
