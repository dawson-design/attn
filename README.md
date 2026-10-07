# attn

Local, read-only dashboard of the GitHub work waiting on you: pull requests that request your review, plus issues assigned to you or mentioning you, with their latest comments. It works against **any GitHub host** (public GitHub or a GitHub Enterprise deployment), configured entirely through environment variables (see [Configuration](#configuration)).

attn builds its feed from `gh search` queries for `@me`. It does not read the GitHub notifications API, so it shows nothing for repos you only watch, and acknowledging an item never marks anything read on GitHub.

attn runs on macOS. The server and terminal UI need only Bun and `gh`, but the login service, the notification window, and the review terminal use launchd, Chrome, and `open`.

The app is built with SvelteKit, Tailwind CSS, and generated shadcn-svelte components. The GitHub integration remains read-only and uses your local `gh` CLI auth for the configured host.

## Install with Homebrew (macOS)

The quickest way to run the dashboard, no clone required:

```bash
brew install kreek/tap/attn
```

```bash
gh auth login --hostname <your-host>   # once; skip for github.com
```

```bash
attn init
```

```bash
brew services start attn
```

`attn init` asks for your GitHub (Enterprise) host and optional local checkout roots, writes `~/.config/attn/env`, checks `gh` auth, and offers to install the login-time Chrome notification window. After `brew services start`, the dashboard is at `http://127.0.0.1:8765` and starts at every login.

- **Configuration** lives in `~/.config/attn/env` — the same `KEY=value` format as `.env` below, and never any secrets (auth stays in `gh`). Edit it, then `brew services restart attn`. Precedence: process environment > config file > default.
- **State** is kept under `~/.local/state/attn/`; server logs under Homebrew's `var/log/`.
- **Notifications**: `attn install-window` / `attn uninstall-window` manage the Chrome window login item (window logs under `~/Library/Logs/attn/`); `attn open` opens the window right now; `attn status` shows the whole setup at a glance.
- A custom review-prompt template can be placed at `~/.config/attn/review.md` (seeded by `init`).

### Moving from ghe-notification-watch

attn was previously named ghe-notification-watch, with the command `ghe-watch` and `GHE_WATCH_*` settings. To keep an old config, rename each `GHE_WATCH_` prefix to `ATTN_` and move `~/.config/ghe-watch/env` to `~/.config/attn/env`. State under `~/.local/state/ghe-watch/` holds only acknowledgements and caches, so you can delete it.

## Terminal UI

`attn watch` shows the same feed in the terminal. It polls on its own, so it works without the server. From a PR row it can open the URL, acknowledge the item, or start `claude` or `codex` with the review prompt in your local checkout. Run `attn watch --help` for its options, or `bun run watch` from a clone.

Run either the terminal UI or the server, not both. Both write the same state file without locking, so an acknowledgement made in one can be lost when the other saves.

## Use with Claude

`attn mcp` is an MCP server on stdio. It talks to the running dashboard server, so start that first (`brew services start attn`). It gives an agent four tools:

| Tool                 | What it does                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `attn_items`         | Lists waiting items, review requests first. Filters by kind; can include acknowledged ones. |
| `attn_ack`           | Acknowledges or unacknowledges items in attn's local state. Writes nothing to GitHub.       |
| `attn_review_prompt` | Returns the local review prompt for a pull request, plus the path of your local clone.      |
| `attn_refresh`       | Re-queries GitHub now instead of waiting for the next poll.                                 |

It also offers a `triage` prompt that proposes an action for each item and changes nothing until you confirm. Every GitHub call still goes through the read-only `gh` allowlist, so no tool can write to GitHub.

### Claude Code

Install the plugin from this repo's marketplace:

```text
/plugin marketplace add kreek/attn
/plugin install attn@attn
```

The plugin adds:

- the `attn` MCP server (it runs `attn mcp`, so `attn` must be on your `PATH`);
- `/attn:triage`, which lists what is waiting and proposes an action for each item;
- `/attn:review`, which reviews a pull request in a temporary git worktree of your local clone and never posts to GitHub;
- a session-start line such as "attn: 2 review requests, 1 mention waiting on github.com", read from the last snapshot with no network calls. It prints nothing when nothing is waiting.

The Code tab in Claude Desktop keeps its own plugin list, so install the plugin there too if you use it.

To use the MCP server without the plugin, run `claude mcp add attn -- attn mcp`.

Everything below describes running from a clone — for development, or a non-Homebrew install.

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
   Edit `.env`: set `ATTN_HOST` (defaults to `github.com`) and, optionally, narrow the feed with `ATTN_REPOS` and/or `ATTN_LABELS` (see [Configuration](#configuration)). `.env` is git-ignored and holds no secrets: auth stays in `gh`.
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
  `ATTN_HOST` / `ATTN_PORT` (or their `.env` values). Re-running is safe.
- **Redeploy** is the patch/iterate command: it rebuilds _before_ restarting, so a
  broken build aborts and leaves the running instance untouched.
- **Logs:** `.local-state/logs/service.{out,err}.log`.
- **Label / status:** the LaunchAgent is labelled `com.<your-username>.attn`;
  check it with `launchctl print gui/$(id -u)/com.$(id -un).attn`.

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

Both scripts are thin delegators to the `attn` CLI (`bun run cli install-window` / `uninstall-window`), which renders the LaunchAgent plist in code (`src/cli/window-agent.ts`) — the same implementation the Homebrew install uses.

- Opens `http://127.0.0.1:8765` as a chromeless Chrome app window (`chrome
--app=...`), not a tab in your regular browsing window. Waits for the
  backend to respond first (`attn open` is the command the agent runs).
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

Homebrew installs read the same variables from `~/.config/attn/env` instead (see [Install with Homebrew](#install-with-homebrew-macos)); precedence everywhere is process environment > config file > default. Path defaults also differ by mode: from a clone, state lives in `.local-state/` and the review prompt in `prompts/review.md`; installed, they move to `~/.local/state/attn/` and `~/.config/attn/review.md`.

- `ATTN_HOST`: target GitHub (Enterprise) host, passed to `gh` as `GH_HOST`. Defaults to `github.com`.
- `ATTN_REPOS`: comma-separated **exact** repo names used to filter the feed. Each entry matches either the bare name (`api`) or the fully-qualified `owner/repo` (`acme/api`). Empty by default. Exact (not prefix) matching lets you watch one repo while omitting a similarly-named sibling.
- `ATTN_LABELS`: comma-separated issue/PR labels used to filter the feed. Empty by default. With both filters empty, every review-requested PR and assigned/mentioned issue is shown; an item is kept if it matches any repo **or** any label.
- `ATTN_CHECKOUT_ROOTS`: comma-separated absolute paths scanned for local git clones (for local agent review). Defaults to the workspace.
- `ATTN_REPO_PATH_MAP`: JSON object of `"owner/repo": "/abs/path"` overrides, merged ahead of the scanned roots. Defaults to `{}`.
- `ATTN_WORKSPACE`: base working directory. Defaults to the current working directory.
- `ATTN_REVIEW_PROMPT_FILE`: path to the markdown template for the local review prompt. Defaults to `./prompts/review.md`. See [Customizing the review prompt](#customizing-the-review-prompt).
- `ATTN_TERMINAL_APP`: macOS app used to open the "review terminal" (must handle `.command` files), e.g. `Terminal`, `iTerm`, `Ghostty`. Unset uses the system default handler.
- `ATTN_PORT`: dashboard port (binds `127.0.0.1` only). Defaults to `8765`.
- `ATTN_ALLOWED_HOSTS`: comma-separated extra hostnames accepted in the `Host` header, in addition to loopback (`localhost`/`127.0.0.1`/`[::1]`). Empty by default. Only set this if you front the dashboard with a reverse proxy under a different name; requests with any other `Host` are rejected to block DNS-rebinding attacks from the browser.
- `ATTN_POLL_SECONDS`: background poll interval. Defaults to `900`.
- `ATTN_STATE_FILE`: defaults to `.local-state/attn/state.json`.
- `ATTN_SNAPSHOT_FILE`: defaults to `.local-state/attn/snapshot.json`.
- `ATTN_CACHE_FILE`: defaults to `.local-state/attn/github-cache.json`.
- `ATTN_LIMIT`: PR search limit, defaults to `50`.
- `ATTN_ISSUE_LIMIT`: issue search limit, defaults to `25`.
- `ATTN_ISSUE_COMMENT_ITEM_LIMIT`: number of issue items to enrich with comments, defaults to `5`.
- `ATTN_COMMENTS_PER_ISSUE`: latest comments (and PR review submissions) kept per item, defaults to `3`; `0` disables comment items.
- `ATTN_PR_SEARCH_TTL_SECONDS`: PR search cache TTL, defaults to `600`.
- `ATTN_ISSUE_SEARCH_TTL_SECONDS`: issue search cache TTL, defaults to `600`. Keep search TTLs below `ATTN_POLL_SECONDS` so each poll actually re-queries.
- `ATTN_PR_VIEW_TTL_SECONDS`: PR view cache TTL, defaults to `1800`.
- `ATTN_ISSUE_VIEW_TTL_SECONDS`: issue view cache TTL, defaults to `3600`.
- `ATTN_RATE_LIMIT_BACKOFF_SECONDS`: cooldown after a GitHub rate-limit response, defaults to `900`.

## Customizing the review prompt

The "Launch Codex/Claude review" action builds a prompt from a markdown template, loaded once at startup from `prompts/review.md` (override with `ATTN_REVIEW_PROMPT_FILE`). Edit that file to change the review instructions, focus areas, or output format without touching code, then restart. Available `{{placeholders}}`:

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

The HTTP server binds to `127.0.0.1` only. Every local account can reach loopback, so a state-changing request from outside a browser (no `Sec-Fetch-Site` or `Origin` header) must send `Authorization: Bearer <token>`. The server writes a new random token and its port to `agent.json` beside the state file on every start, with mode 0600. `attn mcp` reads that file. Browser requests from the dashboard itself do not need the token, and cross-site browser requests are rejected whether or not they carry it.

The browser never receives GitHub tokens or raw `gh` configuration. Local UI actions update local dashboard state (acknowledge), with one exception: the "open review terminal" button writes a fixed-template zsh script and opens it (in the app named by `ATTN_TERMINAL_APP`, or the system default) to check out the PR branch in your existing local clone. The app name is passed as a literal argument to `open -a`, never shell-interpreted. That script runs only local `git` commands, validates PR-author-controlled branch names before inlining them (falling back to `pull/<n>/head`), shell-escapes all free text, and refuses to touch a dirty working tree. Cached GitHub response data stays under `.local-state` and should not be committed.

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

## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml` on macOS: the full
gate, a production build, `scripts/package-artifact.sh` (a self-contained
`libexec/` tarball — bundled server, bundled `attn` CLI, review-prompt
seed), then `scripts/smoke-artifact.sh`, which boots the tarball from a clean
directory and **fails the release** unless loopback serves 200, a foreign
`Host` header gets 403, and state lands in the XDG state dir. On success it
publishes a GitHub release and pushes the rendered formula
(`packaging/homebrew/attn.rb`) to `kreek/homebrew-tap` using the
`TAP_PUSH_TOKEN` repo secret (a fine-grained PAT with `contents: write` on the
tap; without the secret the tap step is skipped with a warning).

```bash
git tag v0.2.0 && git push origin v0.2.0
```
