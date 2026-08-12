# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, **read-only** GitHub notification dashboard for PR-review and issue triage. It works against **any** GitHub host — public GitHub or a GitHub Enterprise deployment — selected via `GHE_WATCH_HOST` (default `github.com`). It surfaces PRs where you're a review-requested reviewer plus issues you're assigned to or mentioned in, summarizes each, and lets you acknowledge them locally. It runs on your machine, binds to `127.0.0.1` only, and never sends GitHub tokens to the browser.

All deployment-specific behavior is environment-driven (`GHE_WATCH_*`, see Configuration); there are no organization-specific defaults baked into the code. Point it at a host and set repo/label filters in your local `.env`.

Stack: SvelteKit (`adapter-node`), Svelte 5, Tailwind v4, shadcn-svelte components, run and tested with **Bun**.

## Commands

```bash
bun install
bun run dev          # vite dev server on http://127.0.0.1:8765
bun run build        # production build (adapter-node -> build/)
bun run serve        # run the built server: bun build/index.js
bun run cli          # the ghe-watch CLI from the checkout (serve/init/install-window/open/status)
bun test             # all tests (bun:test)
bun test test/summary.test.ts    # a single test file
bun test -t "schema" # filter tests by name across files
bun run typecheck    # svelte-kit sync + tsc --noEmit + svelte-check
bun run lint         # ESLint over .ts and .svelte
bun run format       # Prettier write; format:check fails instead of rewriting
bun run lint:shell   # shellcheck over scripts/*.sh (needs shellcheck on PATH)
bun run ci           # every gate, in the order CI runs them
```

`bun run ci` is the gate: `format:check`, `lint`, `lint:shell`, `typecheck`, `test`. Run it before considering a change done — `.github/workflows/ci.yml` runs the same commands plus `bun run build`.

ESLint and Prettier both skip the generated shadcn components in `src/lib/components/ui/`, matching the `tsconfig.json` exclusion. Type-aware ESLint rules are deliberately off because `bun run typecheck` already covers that ground; see the comment in `eslint.config.js`.

`bun` is the runtime here, not Node — tests use `bun:test`, and `tsconfig` types include `bun-types`.

## Architecture

### Server-side singleton service

Everything funnels through one stateful `DashboardService` created in `src/lib/server/dashboard.ts` and cached on `globalThis.vaGheNotificationWatchService`. It is created once per server process, polls on a timer (`GHE_WATCH_POLL_SECONDS`, default 900s), and fans out updates to browser clients over **Server-Sent Events** (`/events`). A `SERVICE_VERSION` constant guards against stale instances surviving dev hot-reload — bump it when the service's shape or behavior changes so old instances are disposed and recreated.

The service owns only persistence, in-flight refresh coalescing, and the broadcast. The fetch pipeline, rate-limit backoff, and reconcile rules live in `refreshWatcherData` (`src/cli/watch-core.ts`), which `runRefresh` delegates to and the terminal watcher shares — so those rules exist once rather than being hand-synced between the two front ends. `createService(deps)` is exported alongside `getDashboardService()` and takes optional seams (`config`, `runner`, `discoverRepos`, `launchTerminal`, `platform`, `startPolling`) so `test/dashboard.test.ts` can drive the real service without network, subprocesses, or timers. Persistence is deliberately not a seam: tests point the config's three file paths at a temp dir so the real save/load paths run. Tests must use `createService` directly — `getDashboardService()` caches on `globalThis` and would leak between tests.

The SvelteKit routes are thin wrappers over this service:

- `src/routes/+page.server.ts` `load()` returns the current snapshot for first paint.
- `src/routes/api/{ack,refresh,items,item-details}/+server.ts` map 1:1 to service methods.
- `src/routes/api/codex-review/+server.ts` returns an agent review prompt for a PR (see local review below).
- `src/routes/events/+server.ts` is the SSE stream; `addClient`/`removeClient` manage subscribers.

### Data pipeline (one refresh)

`fetchWatchItems` (`src/fetch.ts`) is the core. Per refresh it:

1. Runs `gh search prs --review-requested @me` and `gh search issues` (assigned + mentions), filtered by `isRelevant` (exact repo name OR label match from config).
2. Enriches each surviving item with a `gh pr view` / `gh issue view` detail fetch (issue-comment enrichment is capped by `issueCommentItemLimit`).
3. Summarizes via `src/summary.ts` — `summarize` uses the first sentence of the body when available, otherwise the title.
4. Produces `WatchItem`s, including synthetic per-comment items (`pr_comment` / `issue_comment`). Issues that match both the assigned and mentions searches are deduplicated to a single item.

PR review submissions (from `gh pr view --json reviews`) are `pr_comment` items too, not a kind of their own: they differ only in which `gh` field holds them, and the verdict survives in the summary (`Review changes requested: ...`). A bodiless `COMMENTED` review is dropped as noise (`REVIEW_STATES_SHOWN` in `src/fetch.ts`). Because both sources feed one kind, `commentsPerIssue` caps the **merged, time-sorted** list in `prCommentItems` rather than each source separately. Review-sourced ids carry a `review:` segment (`repo#42:pr_comment:review:<id>`) so they cannot collide with comment ids, and `item-details.ts` searches both `comments` and `reviews` when resolving a focused `pr_comment`.

Then `reconcileItems` (`src/state.ts`) merges fetched items against persisted user state to assign each a `lifecycle` (`new`/`unread`/`active`/`acknowledged`), dropping items GitHub no longer returns, and writes back `StoredItem` records. The result is assembled into a `Snapshot` and broadcast.

`src/types.ts` is the contract for all of this (`Config`, `RawSearchItem`, `WatchItem`, `StoredItem`, `AppState`, `Snapshot`) — read it first when touching the pipeline.

### Three persistence files (all under `.local-state/`, git-ignored)

- **`state.json`** (`AppState`) — user intent: per-item `acknowledgedAt`. This is the source of truth for lifecycle. Managed by `src/state.ts`. If the file exists but holds invalid JSON, `loadState` moves it aside to `state.json.corrupt` and starts fresh rather than silently overwriting it (and refuses to start if it cannot move it).
- **`github-cache.json`** (`GithubCache`) — TTL'd raw `gh` responses (`src/github-cache.ts`). Searches and views cache separately with independent TTLs; views are keyed and invalidated on the item's `updatedAt`. Also stores `rateLimitUntil` for backoff. The file records the `host` it was fetched from, and `loadGithubCache(path, host)` discards a cache belonging to a different host — otherwise changing `GHE_WATCH_HOST` serves the previous host's repos and URLs as `fresh` data for the new one. Keep that check when touching cache loading.
- **`snapshot.json`** (`Snapshot`) — the last rendered dashboard, so a cold start shows data immediately (`cacheStatus` downgraded to `stale`).

After a local acknowledge the service mutates `state.json` and applies the change directly onto the in-memory snapshot (`applyLocalStateToSnapshot`) rather than re-fetching. Both that fast path and `reconcileItems` derive lifecycle through the shared `snapshotLifecycle` helper in `src/state.ts`, so they cannot drift apart — change lifecycle rules there.

### Caching, rate-limit, and `cacheStatus`

The cache layer is what keeps this from hammering GHE. On a `gh` failure, `fetch.ts` falls back to stale cache; on a rate-limit error it sets a backoff window (`rateLimitBackoffSeconds`) during which `refresh()` short-circuits unless `force: true`. `cacheStatus` (`fresh`/`partial`/`stale`/`rate_limited`) and `nextRefreshAllowedAt` communicate this to the UI. When changing fetch behavior, preserve the stale-fallback and backoff semantics — they are the point of the cache, not an optimization.

## Security model (do not weaken)

This is a hard constraint of the tool, enforced in `src/gh.ts`:

- Only an allowlist of read commands is permitted (`auth status`, `search prs/issues`, `pr/issue view`, `api`). `gh api` calls are rejected unless they are GET — that includes rejecting field/body flags (`-f`/`-F`/`--field`/`--raw-field`/`--input`) that implicitly flip `gh api` to POST, any non-GET `--method`/`-X` (including `--method=`, `-XPOST`, and clustered short-flag forms like `-iXPOST` that gh's pflag would parse as `-i -X POST`), and `gh api graphql` (which can carry mutations). Any mutating arg (`merge`, `review`, `edit`, `close`, `comment`, `create`, `delete`, …) is rejected.
- All `gh` invocations go through `runGhJson`, which sets `GH_HOST` from config (`GHE_WATCH_HOST`) and uses your existing local `gh` auth.
- The server binds `127.0.0.1` only; tokens and raw `gh` config never reach the browser. Local UI actions mutate local state files, with one deliberate exception below.
- `src/hooks.server.ts` enforces two request guards (pure logic in `src/host-guard.ts`): (1) `isAllowedHost` rejects any request whose `Host` header is not loopback (or an explicit `GHE_WATCH_ALLOWED_HOSTS` entry) — the DNS-rebinding guard, since a rebound request still carries the attacker's original `Host`; (2) `isAllowedRequestOrigin` rejects cross-site state-changing requests (the CSRF guard). Host-pinning alone is **not** a CSRF control: a page on any origin can `fetch("http://127.0.0.1:<port>/api/...")`, which sends a loopback `Host` that passes guard (1). SvelteKit's built-in CSRF check only covers form content types and is off in dev, so guard (2) checks `Sec-Fetch-Site` (falling back to the `Origin` header) and lets through only same-origin requests, user gestures, and non-browser clients. `hooks.server.ts` also sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on every response.
- **The one local-exec surface:** `/api/open-review-terminal` (added by explicit request) writes a fixed-template zsh script (`src/terminal-launch.ts`) and `open`s it so a terminal checks out a PR branch in the local clone. The terminal app is chosen by `GHE_WATCH_TERMINAL_APP` (`config.terminalApp`) and passed as a literal arg to `open -a` — never shell-interpreted; unset falls back to the default `.command` handler. Its inputs are constrained the same way as `local-review.ts`: author-controlled refs must pass `SAFE_REF` or the script falls back to `pull/<n>/head`; all free text (title, path) is single-quote shell-escaped via `shellQuote`; the script refuses to run on a dirty working tree instead of stashing. It runs only local `git` — never `gh`, never network writes.

Any change that would let this tool write to GitHub, broaden the command allowlist, bind a non-loopback host, expose credentials to the client, or widen the terminal-launch template beyond fixed local git commands is out of scope unless explicitly requested — and should be called out loudly.

## Local agent review (`local-review.ts` + workspace discovery)

`src/workspace.ts` discovers local checkouts by reading each directory's `git remote origin` under `checkoutRoots`, parsing the `owner/<repo>` slug, and mapping repo → local path (seeded by `repoPathMap` in `src/config.ts`). That `localPath` lets the dashboard hand off a PR to an agent: `local-review.ts` builds a review prompt by rendering a markdown template (`src/review-prompt.ts`; loaded from `prompts/review.md` at startup, overridable via `GHE_WATCH_REVIEW_PROMPT_FILE`) whose `{{...}}` placeholders it fills. The shell setup block (`{{setup}}`) is code-generated, not templated: after a stash guard it checks out the PR ref in the existing local clone, with PR-author-controlled refs validated by `safeRef()`/`checkoutSteps()` so a custom template can never bypass the injection guard. Branch and base refs from GitHub are PR-author-controlled, so they are validated against a conservative allowlist (`SAFE_REF`) before being inlined into the runnable snippet; anything that fails falls back to fetching the PR head by its integer number (`pull/<n>/head`). The `codex-review` endpoint exposes this.

Local checkouts are discovered by scanning `GHE_WATCH_CHECKOUT_ROOTS` (default: the workspace) for git remotes matching `GHE_WATCH_HOST`, plus explicit `GHE_WATCH_REPO_PATH_MAP` (JSON `"owner/repo": "/abs/path"`) overrides. `src/config.ts` holds no hardcoded paths.

## Configuration

All config is environment-driven through `loadConfig()` in `src/config.ts` — `stringFrom`/`numberFrom`/`listFrom`/`mapFrom` over a single merged env map, with defaults. Every variable is prefixed `GHE_WATCH_`; see `.env.example` (the canonical annotated list) and `README.md` for the full set (host, port, poll interval, repos, labels, checkout roots, repo path map, search limits, per-cache TTLs, rate-limit backoff, state/snapshot/cache file paths). Relevance filters (`repos`, `labels`) default to empty, meaning "show everything the personal searches return" — `isRelevant` in `src/fetch.ts` short-circuits to `true` when both are empty. `repos` is an **exact** allowlist matched against either the bare repo name or `owner/repo` (not a prefix), so a repo can be watched while a same-family sibling is excluded. The review-prompt template is loaded here too (`reviewPromptTemplate`, via `loadReviewPromptTemplate`, falling back to `DEFAULT_REVIEW_PROMPT`), the review-terminal app (`terminalApp` from `GHE_WATCH_TERMINAL_APP`), and the Host-header allowlist (`allowedHosts`, consumed lazily by `hooks.server.ts`). Add new tunables here rather than reading `process.env` elsewhere.

**Two runtime modes**, selected by `GHE_WATCH_HOME` (`src/paths.ts`, pure and injectable): unset = **dev mode**, every path default is cwd-relative exactly as before (state in `.local-state/`, prompt from `prompts/review.md`, config via Bun's `.env` auto-load, checkout scan of the workspace). Set (only ever by the packaged `ghe-watch` wrapper, pointing at its libexec) = **installed mode**: config is read by the app itself from `~/.config/ghe-watch/env` (parsed by `src/config-file.ts`, whose dialect deliberately matches `gw_env_file_value()` in `scripts/lib.sh`), state moves to `~/.local/state/ghe-watch/`, the prompt override to `~/.config/ghe-watch/review.md`, and `checkoutRoots` defaults to **empty** (no implicit `$HOME` scan — `ghe-watch init` asks). Precedence for every value: process env > config file > mode default. Don't introduce new cwd-relative paths; route them through `resolveAppPaths`.

## Packaging & distribution

Run-only users install via Homebrew (`brew install kreek/tap/ghe-watch`); the clone flow is unchanged for contributors. The pieces:

- **`src/cli/main.ts`** (`bun run cli`, shipped as `ghe-watch`): `serve` (imports the adapter-node entry in-process — what `brew services` supervises), `init`, `install-window`/`uninstall-window`/`open` (the Chrome window LaunchAgent, plist rendered in code by `src/cli/window-agent.ts` — the label is shared with the dev scripts so reinstalls replace rather than orphan), `status`. `scripts/{install,uninstall}-window-launcher.sh` are thin delegators to it.
- **`scripts/package-artifact.sh`** bundles `build/index.js` and the CLI with `bun build --target=bun` into a self-contained `libexec/` tarball (no `node_modules` at runtime; `build/client/` ships alongside because the handler resolves assets file-relatively).
- **`scripts/smoke-artifact.sh`** boots that tarball from a clean dir and asserts the release invariants: loopback 200, foreign `Host` → 403, state under XDG, nothing written cwd-relative. `.github/workflows/release.yml` (tag `v*`, macOS runner) runs the full gate, packages, smokes, publishes the GitHub release, and pushes the rendered `packaging/homebrew/ghe-watch.rb` template to `kreek/homebrew-tap` (needs the `TAP_PUSH_TOKEN` secret).

The security model above applies to the packaged artifact identically — the smoke's 403 check is a hard release gate, and the formula's service block bakes in no host/port (the app reads its config file at startup, so `brew services restart` picks up changes).

## Conventions

- shadcn-svelte UI components live under `src/lib/components/ui/` and are **generated** — they're excluded from typecheck (`tsconfig` `exclude`) and shouldn't be hand-edited as if they were app code. `components.json` drives `shadcn-svelte` generation (`rhea` style, lucide icons).
- Pure logic (`summary.ts`, `state.ts`, `github-cache.ts`, `workspace.ts`, `gh.ts`, `paths.ts`, `config-file.ts`, `cli/window-agent.ts`) is kept free of SvelteKit imports and is where the unit tests live (`test/*.test.ts`). Keep new business logic in these modules, testable in isolation, with the route/service layer thin.
- Test fixtures that need a `Config` should give the cache TTLs a **negative** value when the test wants every refresh to re-run its fake `gh` runner. Freshness is `age <= ttl * 1000`, so a `0` TTL still counts as fresh for two calls landing in the same millisecond, which makes such tests intermittently green.
