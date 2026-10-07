import { describe, expect, test } from "bun:test";
import { renderWindowPlist, windowAgentLabel } from "../src/cli/window-agent";

const SPEC = {
  label: "com.someone.attn-window",
  programArgs: ["/opt/homebrew/opt/attn/bin/attn", "open"],
  path: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  port: 8765,
  logDir: "/Users/someone/Library/Logs/attn",
};

describe("windowAgentLabel", () => {
  test("is user-namespaced and shared across modes", () => {
    expect(windowAgentLabel("someone")).toBe("com.someone.attn-window");
  });
});

describe("renderWindowPlist", () => {
  test("renders each program argument as its own string entry", () => {
    const plist = renderWindowPlist(SPEC);
    expect(plist).toContain("<string>/opt/homebrew/opt/attn/bin/attn</string>");
    expect(plist).toContain("<string>open</string>");
    expect(plist).toContain("<string>com.someone.attn-window</string>");
  });

  test("runs at load but never keeps the window alive", () => {
    const plist = renderWindowPlist(SPEC);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).not.toContain("KeepAlive");
  });

  test("passes PATH and the port to the launchd environment", () => {
    const plist = renderWindowPlist(SPEC);
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(plist).toContain("<key>ATTN_PORT</key>");
    expect(plist).toContain("<string>8765</string>");
  });

  test("writes logs under the given log dir", () => {
    const plist = renderWindowPlist(SPEC);
    expect(plist).toContain("<string>/Users/someone/Library/Logs/attn/window.out.log</string>");
    expect(plist).toContain("<string>/Users/someone/Library/Logs/attn/window.err.log</string>");
  });

  test("XML-escapes values so paths cannot corrupt the plist", () => {
    const plist = renderWindowPlist({ ...SPEC, logDir: '/tmp/it\'s <b>&"odd"' });
    expect(plist).toContain("/tmp/it&apos;s &lt;b&gt;&amp;&quot;odd&quot;/window.out.log");
    expect(plist).not.toContain("<b>");
  });
});
