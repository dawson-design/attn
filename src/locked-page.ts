// The page an unauthenticated browser gets. Its script trades a one-time
// `#code=` from `attn open` for the session cookie, then reloads.
export const LOCKED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>attn is locked</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem; color: #1f2328; background: #fff; }
  code { font: 13px ui-monospace, monospace; background: #f6f8fa; padding: 0.1rem 0.3rem; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } code { background: #161b22; } }
</style>
</head>
<body>
<h1>attn is locked</h1>
<p id="status">Open the dashboard from a terminal with <code>attn open</code>. To use another browser, run <code>attn open --print</code> and paste the one-time link it prints.</p>
<script>
  // Runs on load and on hashchange: pasting a link into a tab that already
  // shows this page only changes the fragment, which does not reload it.
  function signIn() {
    const match = location.hash.match(/^#code=([A-Za-z0-9_-]+)$/);
    if (!match) return;
    history.replaceState(null, "", "/");
    const status = document.getElementById("status");
    status.textContent = "Signing in...";
    fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: match[1] }),
    }).then((response) => {
      if (response.ok) location.replace("/");
      else status.textContent = "That sign-in link has expired or was already used. Run attn open again.";
    });
  }
  window.addEventListener("hashchange", signIn);
  signIn();
</script>
</body>
</html>
`;
