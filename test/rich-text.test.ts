import { describe, expect, test } from "bun:test";
import { renderRichText, sanitizeHtml } from "../src/rich-text";

describe("sanitizeHtml", () => {
  test("keeps basic formatting tags and removes scripts", () => {
    expect(sanitizeHtml("<p>Hello <strong>world</strong></p><script>alert(1)</script>")).toBe(
      "<p>Hello <strong>world</strong></p>",
    );
  });

  test("removes unsafe attributes and javascript links", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)" onclick="x()">bad</a>')).toBe("<a>bad</a>");
    expect(sanitizeHtml('<a href="https://ghe.example.com/x" onclick="x()">ok</a>')).toBe(
      '<a href="https://ghe.example.com/x" target="_blank" rel="noreferrer">ok</a>',
    );
  });
});

describe("renderRichText", () => {
  test("renders common markdown", () => {
    expect(renderRichText("**Bold** and [link](https://ghe.example.com/x)")).toContain("<strong>Bold</strong>");
    expect(renderRichText("**Bold** and [link](https://ghe.example.com/x)")).toContain(
      '<a href="https://ghe.example.com/x" target="_blank" rel="noreferrer">link</a>',
    );
  });

  test("renders safe inline html", () => {
    expect(renderRichText("<p>Hello <strong>world</strong></p>")).toBe("<p>Hello <strong>world</strong></p>");
  });

  test("renders lists and code blocks", () => {
    const html = renderRichText("- one\n- `two`\n\n```\n<script>\n```");
    expect(html).toContain("<ul><li>one</li><li><code>two</code></li></ul>");
    expect(html).toContain("<pre><code>&lt;script&gt;</code></pre>");
  });

  test("renders code containing $ replacement patterns literally", () => {
    // `$&`, `$\`` and `$'` are special in String.replace replacements; a code
    // span holding them must not splice document text into the output.
    const html = renderRichText("inline `a $& b` end");
    expect(html).toContain("<code>a $&amp; b</code>");
    expect(html).not.toContain("INLINE_CODE");
  });
});
