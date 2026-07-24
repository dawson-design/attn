# GHE Notification Watch

Local, read-only GitHub notification dashboard for PR-review and issue triage. It works against **any GitHub host** (public GitHub or a GitHub Enterprise deployment), configured entirely through environment variables (see [Configuration](#configuration)).

The app is built with SvelteKit, Tailwind CSS, and generated shadcn-svelte components. The GitHub integration remains read-only and uses your local `gh` CLI auth for the configured host.

## Prerequisites (macOS)

Install these once. The always-on service and the notification window are macOS-specific (launchd plus Chrome).

- **Bun** (runtime and package manager): `curl -fsSL https://bun.sh/install | bash` (see https://bun.sh).
- **GitHub CLI** (`gh`, provides auth and read-only API access): `brew install gh` (see https://cli.github.com).
- **Google Chrome** (for the auto-opened notification window): `brew install --cask google-chrome`. Any browser can show notifications if you keep the page open yourself; only the login-time window launcher is Chrome-specific.

## Set up the always-on app with browser notifications (macOS)

The full path to a dashboard that runs at login and raises a desktop notification for each new item. Each step links to its detailed section below.

1. **Authenticate `gh`** against your host (once):
   ```bash
   gh auth login --hostname <your-host>   # e.g. ghe.example.com; skip for github.com
   ```
2. **Install dependencies and configure.** From the repo root:
   ```bash
   bun install
   cp .env.example .env
   ```
   Edit `.env`: set `GHE_WATCH_HOST` (defaults to `github.com`) and, optionally, narrow the feed with `GHE_WATCH_REPOS` and/or `GHE_WATCH_LABELS` (see [Configuration](#configuration)). `.env` is git-ignored and holds no secrets: auth stays in `gh`.
3. **Start the backend at login** (builds, installs the LaunchAgent, starts it):
   ```bash
   scripts/install-service.sh
   ```
   Confirm it is up by opening `http://127.0.0.1:8765`. Details: [Run as a local service](#run-as-a-local-service-macos).
4. **Open the notification window at login:**
   ```bash
   scripts/install-window-launcher.sh
   ```
   A chromeless Chrome window opens to the dashboard once the backend responds. Details: [Desktop notifications](#desktop-notifications-macos).
5. **Enable notifications** (one-time): in that window, click **Enable notifications** in the header and allow Chrome's prompt. The header then reads "Notifications on", and new items raise a desktop notification.

After a reboot both pieces start automatically, so notifications keep flowing with no terminal open.

## Run in development

For iterating on the code, without the LaunchAgent or auto-start:

```bash
bun install
bun run dev            # http://127.0.0.1:8765
```

Production build smoke test:

```bash
bun run build
bun run serve
```

## Run as a local service (macOS)

Run the dashboard as an always-on background service via a per-user **LaunchAgent**.
It starts at login, restarts on crash, and keeps the 15-minute poll loop running
without a terminal open. It runs as you, so it reuses your local `gh` auth for the
configured host.

```bash
scripts/install-service.sh     # one-time: build + install + start
scripts/redeploy.sh            # after editing code: rebuild + restart
scripts/uninstall-service.sh   # stop + remove (keeps .local-state/)
```

- **Install** renders `scripts/service.plist.template` into `~/Library/LaunchAgents/`
  and loads it, deriving all machine-specific values (checkout path, `bun`/`gh`
  locations, `PATH`) from your machine and the target host/port from
  `GHE_WATCH_HOST` / `GHE_WATCH_PORT` (or their `.env` values). Re-running is safe.
- **Redeploy** is the patch/iterate command: it rebuilds _before_ restarting, so a
  broken build aborts and leaves the running instance untouched.
- **Logs:** `.local-state/logs/service.{out,err}.log`.
- **Label / status:** the LaunchAgent is labelled `com.<your-username>.ghe-notification-watch`;
  check it with `launchctl print gui/$(id -u)/com.$(id -un).ghe-notification-watch`.

Notes:

- This is a **LaunchAgent** (login scope), not a root LaunchDaemon. That is
  deliberate: only your user session has your `gh` credentials and keychain.
- Run `gh auth login --hostname <your-host>` first; otherwise the service starts
  but shows empty/stale data.
- The rendered plist uses absolute paths to `bun`, `gh`, and this checkout because
  launchd does not inherit your shell `PATH`. If you move the checkout or change
  toolchain locations, just re-run `scripts/install-service.sh` to re-render it.

## Desktop notifications (macOS)

The dashboard sends a native notification for each new item over its live
`/events` stream, but that code runs in the page itself (`EventSource` +
`Notification`, no service worker), so it only fires while a browser window has
the page open. `install-service.sh` above starts the _backend_; this second
LaunchAgent opens a dedicated Chrome app window at login so the page is always
there to receive them:

```bash
scripts/install-window-launcher.sh     # one-time: open a Chrome app window at login
scripts/uninstall-window-launcher.sh   # stop opening it
```

- Opens `http://127.0.0.1:8765` as a chromeless Chrome app window (`chrome
--app=...`), not a tab in your regular browsing window. Waits for the
  backend to respond first.
- **One-time step:** in that window, click "Enable notifications" in the
  dashboard header and allow the Chrome permission prompt. This is a
  per-Chrome-profile permission and persists across restarts.
- No `KeepAlive`: if you close the window, it stays closed until next login
  (or you re-run the installer). It won't fight you for closing it.
- If macOS notifications still don't appear after granting the in-page
  permission, check System Settings → Notifications → Google Chrome is
  allowed.

## Configuration

All configuration is environment-driven (see `loadConfig()` in `src/config.ts`). Copy `.env.example` to `.env` and uncomment what you need; Bun auto-loads `.env` for both `bun run dev` and `bun run serve`. **No secrets belong in `.env`**: GitHub auth comes from `gh`.

- `GHE_WATCH_HOST`: target GitHub (Enterprise) host, passed to `gh` as `GH_HOST`. Defaults to `github.com`.
- `GHE_WATCH_REPOS`: comma-separated **exact** repo names used to filter the feed. Each entry matches either the bare name (`api`) or the fully-qualified `owner/repo` (`acme/api`). Empty by default. Exact (not prefix) matching lets you watch one repo while omitting a similarly-named sibling.
- `GHE_WATCH_LABELS`: comma-separated issue/PR labels used to filter the feed. Empty by default. With both filters empty, every review-requested PR and assigned/mentioned issue is shown; an item is kept if it matches any repo **or** any label.
- `GHE_WATCH_CHECKOUT_ROOTS`: comma-separated absolute paths scanned for local git clones (for local agent review). Defaults to the workspace.
- `GHE_WATCH_REPO_PATH_MAP`: JSON object of `"owner/repo": "/abs/path"` overrides, merged ahead of the scanned roots. Defaults to `{}`.
- `GHE_WATCH_WORKSPACE`: base working directory. Defaults to the current working directory.
- `GHE_WATCH_REVIEW_PROMPT_FILE`: path to the markdown template for the local review prompt. Defaults to `./prompts/review.md`. See [Customizing the review prompt](#customizing-the-review-prompt).
- `GHE_WATCH_TERMINAL_APP`: macOS app used to open the "review terminal" (must handle `.command` files), e.g. `Terminal`, `iTerm`, `Ghostty`. Unset uses the system default handler.
- `GHE_WATCH_PORT`: dashboard port (binds `127.0.0.1` only). Defaults to `8765`.
- `GHE_WATCH_ALLOWED_HOSTS`: comma-separated extra hostnames accepted in the `Host` header, in addition to loopback (`localhost`/`127.0.0.1`/`[::1]`). Empty by default. Only set this if you front the dashboard with a reverse proxy under a different name; requests with any other `Host` are rejected to block DNS-rebinding attacks from the browser.
- `GHE_WATCH_POLL_SECONDS`: background poll interval. Defaults to `900`.
- `GHE_WATCH_STATE_FILE`: defaults to `.local-state/ghe-notification-watch/state.json`.
- `GHE_WATCH_SNAPSHOT_FILE`: defaults to `.local-state/ghe-notification-watch/snapshot.json`.
- `GHE_WATCH_CACHE_FILE`: defaults to `.local-state/ghe-notification-watch/github-cache.json`.
- `GHE_WATCH_LIMIT`: PR search limit, defaults to `50`.
- `GHE_WATCH_ISSUE_LIMIT`: issue search limit, defaults to `25`.
- `GHE_WATCH_ISSUE_COMMENT_ITEM_LIMIT`: number of issue items to enrich with comments, defaults to `5`.
- `GHE_WATCH_COMMENTS_PER_ISSUE`: latest comments (and PR review submissions) kept per item, defaults to `3`; `0` disables comment items.
- `GHE_WATCH_PR_SEARCH_TTL_SECONDS`: PR search cache TTL, defaults to `600`.
- `GHE_WATCH_ISSUE_SEARCH_TTL_SECONDS`: issue search cache TTL, defaults to `600`. Keep search TTLs below `GHE_WATCH_POLL_SECONDS` so each poll actually re-queries.
- `GHE_WATCH_PR_VIEW_TTL_SECONDS`: PR view cache TTL, defaults to `1800`.
- `GHE_WATCH_ISSUE_VIEW_TTL_SECONDS`: issue view cache TTL, defaults to `3600`.
- `GHE_WATCH_RATE_LIMIT_BACKOFF_SECONDS`: cooldown after a GitHub rate-limit response, defaults to `900`.

## Customizing the review prompt

The "Launch Codex/Claude review" action builds a prompt from a markdown template, loaded once at startup from `prompts/review.md` (override with `GHE_WATCH_REVIEW_PROMPT_FILE`). Edit that file to change the review instructions, focus areas, or output format without touching code, then restart. Available `{{placeholders}}`:

| Placeholder         | Value                                                     |
| ------------------- | --------------------------------------------------------- |
| `{{repo}}`          | `owner/repo`, e.g. `acme/api`                             |
| `{{number}}`        | PR number                                                 |
| `{{title}}`         | PR title                                                  |
| `{{url}}`           | PR URL (reference only)                                   |
| `{{base}}`          | base branch (validated, defaults to `main`)               |
| `{{branch}}`        | branch to review (head branch, or `pr-<number>`)          |
| `{{prBranch}}`      | head branch name, or a note when missing/unsafe to inline |
| `{{localCheckout}}` | local checkout path, or a "not found" note                |
| `{{setup}}`         | the git-checkout shell block                              |

`{{setup}}` is **code-generated**, not something the template defines: it contains the git commands the agent runs, built from PR-author-controlled branch names that are validated (`safeRef`) before being inlined. The template lays out prose around it but cannot alter those commands, so editing the template can't introduce shell injection. Unknown placeholders are left as-is so typos are visible.

## Security Model

The app is read-only against GitHub. It uses existing `gh` auth and allowlists only read commands. It rejects GitHub mutation commands and non-GET API calls.

The HTTP server binds to `127.0.0.1` only. The browser never receives GitHub tokens or raw `gh` configuration. Local UI actions update local dashboard state (acknowledge), with one exception: the "open review terminal" button writes a fixed-template zsh script and opens it (in the app named by `GHE_WATCH_TERMINAL_APP`, or the system default) to check out the PR branch in your existing local clone. The app name is passed as a literal argument to `open -a`, never shell-interpreted. That script runs only local `git` commands, validates PR-author-controlled branch names before inlining them (falling back to `pull/<n>/head`), shell-escapes all free text, and refuses to touch a dirty working tree. Cached GitHub response data stays under `.local-state` and should not be committed.

## Checks

One command runs every gate, in the same order CI runs them:

```bash
bun run ci
```

That is `format:check`, `lint`, `lint:shell`, `typecheck`, and `test`. Run them
individually while iterating:

```bash
bun run format         # rewrite files with Prettier
bun run format:check   # fail instead of rewriting (what CI runs)
bun run lint           # ESLint over .ts and .svelte
bun run lint:fix       # apply the fixable subset
bun run lint:shell     # shellcheck over scripts/*.sh
bun run typecheck      # svelte-kit sync + tsc --noEmit + svelte-check
bun test               # bun:test suite
bun run coverage       # the suite with coverage output
bun run build          # production build (adapter-node)
```

`lint:shell` needs [shellcheck](https://www.shellcheck.net) on your PATH
(`brew install shellcheck`); it is preinstalled on the CI runner.

Generated shadcn-svelte components under `src/lib/components/ui/` are excluded
from linting and formatting, matching the existing `tsconfig.json` exclusion.

CI (`.github/workflows/ci.yml`) runs the same checks plus `bun run build` on
every push and pull request.
