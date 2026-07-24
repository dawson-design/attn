<script lang="ts">
  import { onMount } from "svelte";
  import BellIcon from "@lucide/svelte/icons/bell";
  import BellOffIcon from "@lucide/svelte/icons/bell-off";
  import BotIcon from "@lucide/svelte/icons/bot";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import * as Table from "$lib/components/ui/table";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { isDependencyBotItem } from "../actors";
  import { renderRichText } from "../rich-text";
  import type { Snapshot, WatchItem, WatchItemDetails } from "../types";
  import type { PageData } from "./$types";

  type DetailsState =
    | { status: "loading" }
    | { status: "loaded"; details: WatchItemDetails; itemUpdatedAt: string }
    | { status: "error"; error: string };

  let { data }: { data: PageData } = $props();
  const initialSnapshot: Snapshot = (() => data.snapshot)();

  let items = $state<WatchItem[]>(initialSnapshot.items || []);
  let errors = $state<string[]>(initialSnapshot.errors || []);
  let mutedRepos = $state<string[]>(initialSnapshot.mutedRepos || []);
  let connection = $state("connecting");
  let lastUpdated = $state(formatHeaderTime(initialSnapshot.generatedAt));
  let cacheStatus = $state<Snapshot["cacheStatus"]>(initialSnapshot.cacheStatus || "stale");
  let nextRefreshAllowedAt = $state(initialSnapshot.nextRefreshAllowedAt || "");
  let refreshing = $state(false);
  let query = $state("");
  let kind = $state("");
  let showAcknowledged = $state(false);
  let showMuted = $state(false);
  let pageSizeChoice = $state("25");
  let currentPage = $state(1);
  let prefsLoaded = $state(false);
  let notificationPermission = $state("default");
  let loadedOnce = $state(false);
  let copyingReviewPromptId = $state("");
  let copiedReviewPromptId = $state("");
  let openingTerminalId = $state("");
  let expandedItemIds = $state<Set<string>>(new Set());
  let detailsById = $state<Record<string, DetailsState>>({});

  let kindValue = $derived(kind);
  let filteredItems = $derived(
    sortedItems(items).filter((item) => {
      if (!showMuted && item.lifecycle === "muted") return false;
      if (!showAcknowledged && item.lifecycle === "acknowledged") return false;
      const normalizedQuery = query.trim().toLowerCase();
      if (kindValue && item.kind !== kindValue) return false;
      if (!normalizedQuery) return true;
      return [item.repo, item.title, item.actor, item.summary].join(" ").toLowerCase().includes(normalizedQuery);
    }),
  );
  let mutedCount = $derived(items.filter((item) => item.lifecycle === "muted").length);
  let acknowledgedCount = $derived(items.filter((item) => item.lifecycle === "acknowledged").length);
  let notificationLabel = $derived(getNotificationLabel(notificationPermission));
  let cacheLabel = $derived(getCacheLabel(refreshing, cacheStatus, nextRefreshAllowedAt));

  // Client-side pagination over the already-filtered list. All items are in the
  // snapshot (bounded by the fetch caps), so paging is a view concern only.
  let pageSize = $derived(Number(pageSizeChoice) || 25);
  let pageCount = $derived(Math.max(1, Math.ceil(filteredItems.length / pageSize)));
  let pageItems = $derived(filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize));
  let pageStart = $derived(filteredItems.length === 0 ? 0 : (currentPage - 1) * pageSize + 1);
  let pageEnd = $derived(Math.min(currentPage * pageSize, filteredItems.length));

  // Reset to the first page when a filter/control changes. These are only
  // touched by the user, so this never yanks the view back to page 1 when new
  // items arrive over SSE.
  $effect(() => {
    void [query, kindValue, showMuted, showAcknowledged, pageSize];
    currentPage = 1;
  });
  // When a live update shrinks the list, clamp the page rather than stranding
  // the view on a now-empty page.
  $effect(() => {
    if (currentPage > pageCount) currentPage = pageCount;
  });

  // Keep open detail panels current. When an SSE snapshot bumps an expanded
  // item's updatedAt, re-fetch its details; otherwise the panel keeps showing
  // stale body/comments until the user collapses and re-expands it. Once
  // reloaded, itemUpdatedAt matches again so this does not loop.
  $effect(() => {
    for (const id of expandedItemIds) {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) continue;
      const state = detailsById[id];
      if (state?.status === "loaded" && state.itemUpdatedAt !== item.updatedAt) {
        void loadItemDetails(item);
      }
    }
  });

  // Persist view preferences. Gated on prefsLoaded so the initial default does
  // not overwrite a saved value before onMount has loaded it.
  $effect(() => {
    if (prefsLoaded) localStorage.setItem("ghe-watch:pageSize", pageSizeChoice);
  });
  $effect(() => {
    if (prefsLoaded) localStorage.setItem("ghe-watch:showAcknowledged", String(showAcknowledged));
  });

  onMount(() => {
    notificationPermission = "Notification" in window ? Notification.permission : "denied";
    // Restore view preferences (the always-on window reloads, so these should
    // persist). Loading here, post-hydration, avoids an SSR mismatch.
    const savedSize = localStorage.getItem("ghe-watch:pageSize");
    if (savedSize && ["10", "25", "50", "100"].includes(savedSize)) pageSizeChoice = savedSize;
    const savedAck = localStorage.getItem("ghe-watch:showAcknowledged");
    if (savedAck != null) showAcknowledged = savedAck === "true";
    prefsLoaded = true;
    const source = new EventSource("/events");
    source.addEventListener("open", () => {
      connection = "connected";
    });
    source.addEventListener("error", () => {
      connection = "disconnected";
    });
    source.addEventListener("snapshot", (event) => {
      const previousIds = new Set(items.map((item) => item.id));
      applySnapshot(JSON.parse(event.data) as Snapshot);
      if (loadedOnce) {
        for (const item of items) {
          if (!previousIds.has(item.id) && item.lifecycle === "new") notify(item);
        }
      }
      loadedOnce = true;
    });
    return () => source.close();
  });

  function sortedItems(value: WatchItem[]): WatchItem[] {
    return [...value].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  function applySnapshot(snapshot: Snapshot): void {
    items = snapshot.items || [];
    errors = Array.from(new Set(snapshot.errors || []));
    mutedRepos = snapshot.mutedRepos || [];
    cacheStatus = snapshot.cacheStatus || "stale";
    nextRefreshAllowedAt = snapshot.nextRefreshAllowedAt || "";
    lastUpdated = formatHeaderTime(snapshot.generatedAt);
  }

  function getNotificationLabel(permission: string): string {
    if (typeof window === "undefined" || !("Notification" in window)) return "Notifications unavailable";
    if (permission === "granted") return "Notifications on";
    if (permission === "denied") return "Notifications blocked";
    return "Enable notifications";
  }

  function getCacheLabel(isRefreshing: boolean, status: Snapshot["cacheStatus"], nextRefresh: string): string {
    if (isRefreshing) return "refreshing";
    if (status === "rate_limited" && nextRefresh) {
      return `rate limited until ${new Date(nextRefresh).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
    if (status === "fresh") return "cached";
    if (status === "partial") return "partial cache";
    return "stale cache";
  }

  function labelKind(value: string): string {
    return value.replaceAll("_", " ");
  }

  function formatHeaderTime(value: string | undefined): string {
    return value ? new Date(value).toLocaleTimeString() : "unknown";
  }

  function formatDate(value: string | undefined): string {
    if (!value) return "unknown";
    const date = new Date(value);
    const options: Intl.DateTimeFormatOptions = {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    };
    if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
    return date.toLocaleString([], options);
  }

  function reportError(message: string): void {
    errors = Array.from(new Set([message, ...errors]));
  }

  async function refresh(): Promise<void> {
    refreshing = true;
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      if (!response.ok) {
        // A failed refresh returns an error body, not a Snapshot. Applying it
        // would coerce items/errors/mutedRepos to empty and blank the dashboard,
        // so surface the failure and leave the current snapshot in place.
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        reportError(body.error || `Refresh failed (${response.status}).`);
        return;
      }
      applySnapshot((await response.json()) as Snapshot);
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    } finally {
      refreshing = false;
    }
  }

  async function setAck(id: string, acknowledged: boolean): Promise<void> {
    try {
      const response = await fetch("/api/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], acknowledged }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        reportError(body.error || "Acknowledge failed.");
      }
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  }

  function isExpanded(id: string): boolean {
    return expandedItemIds.has(id);
  }

  function detailsRegionId(item: WatchItem): string {
    return `details-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  async function toggleDetails(item: WatchItem): Promise<void> {
    // A plain Set is correct here: it is never mutated in place. This copy is
    // reassigned to expandedItemIds below, and that reassignment is what drives
    // reactivity, so SvelteSet would buy nothing.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const nextExpanded = new Set(expandedItemIds);
    if (nextExpanded.has(item.id)) {
      nextExpanded.delete(item.id);
      expandedItemIds = nextExpanded;
      return;
    }

    nextExpanded.add(item.id);
    expandedItemIds = nextExpanded;
    const cached = detailsById[item.id];
    if (
      !cached ||
      cached.status === "error" ||
      (cached.status === "loaded" && cached.itemUpdatedAt !== item.updatedAt)
    ) {
      await loadItemDetails(item);
    }
  }

  async function loadItemDetails(item: WatchItem): Promise<void> {
    const { id } = item;
    detailsById = { ...detailsById, [id]: { status: "loading" } };
    try {
      const response = await fetch("/api/item-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        details?: WatchItemDetails;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.details) {
        throw new Error(body.error || "Item details failed.");
      }
      detailsById = {
        ...detailsById,
        [id]: { status: "loaded", details: body.details, itemUpdatedAt: item.updatedAt },
      };
    } catch (error) {
      detailsById = {
        ...detailsById,
        [id]: { status: "error", error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function copyAgentReviewPrompt(id: string): Promise<void> {
    copyingReviewPromptId = id;
    try {
      const response = await fetch("/api/codex-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        errors = Array.from(new Set([body.error || "Agent review prompt failed.", ...errors]));
        return;
      }
      const body = (await response.json()) as { prompt?: string };
      if (!body.prompt) throw new Error("Agent review prompt was empty.");
      await navigator.clipboard.writeText(body.prompt);
      copiedReviewPromptId = id;
      setTimeout(() => {
        if (copiedReviewPromptId === id) copiedReviewPromptId = "";
      }, 2500);
    } catch (error) {
      errors = Array.from(new Set([error instanceof Error ? error.message : String(error), ...errors]));
    } finally {
      copyingReviewPromptId = "";
    }
  }

  async function openReviewTerminal(id: string): Promise<void> {
    openingTerminalId = id;
    try {
      const response = await fetch("/api/open-review-terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        errors = Array.from(new Set([body.error || "Opening the review terminal failed.", ...errors]));
      }
    } catch (error) {
      errors = Array.from(new Set([error instanceof Error ? error.message : String(error), ...errors]));
    } finally {
      openingTerminalId = "";
    }
  }

  async function setRepoMuted(repo: string, muted: boolean): Promise<void> {
    try {
      const response = await fetch("/api/mute-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, muted }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        reportError(body.error || "Mute failed.");
      }
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  }

  async function enableNotifications(): Promise<void> {
    if (!("Notification" in window)) return;
    notificationPermission = await Notification.requestPermission();
    if (notificationPermission === "granted") {
      new Notification("GHE notifications enabled", {
        body: "New active items will appear here while the dashboard is open.",
      });
    }
  }

  function notify(item: WatchItem): void {
    if (notificationPermission !== "granted") return;
    new Notification(`${labelKind(item.kind)}: ${item.repo} #${item.number}`, {
      body: item.title,
      tag: item.id,
    });
  }

  async function copyDigest(): Promise<void> {
    const lines = ["# GHE Notification Watch Digest", ""];
    for (const item of filteredItems) {
      lines.push(`## ${item.repo} #${item.number}`);
      lines.push("");
      lines.push(item.summary);
      lines.push("");
      lines.push(`- Kind: ${labelKind(item.kind)}`);
      lines.push(`- Lifecycle: ${item.lifecycle}`);
      lines.push(`- URL: ${item.url}`);
      lines.push("");
    }
    await navigator.clipboard.writeText(lines.join("\n"));
  }

  function typeClass(item: WatchItem): string {
    if (item.kind === "pr_review_request") return "border-l-sky-500";
    if (item.kind === "pr_comment" || item.kind === "pr_review_comment") return "border-l-violet-500";
    if (item.kind === "issue_assigned") return "border-l-amber-500";
    if (item.kind === "issue_mention") return "border-l-emerald-500";
    return "border-l-rose-500";
  }

  function typeBadgeClass(item: WatchItem): string {
    if (item.kind === "pr_review_request") return "border-sky-500/20 bg-sky-500/15 text-sky-200";
    if (item.kind === "pr_comment" || item.kind === "pr_review_comment") {
      return "border-violet-500/20 bg-violet-500/15 text-violet-200";
    }
    if (item.kind === "issue_assigned") return "border-amber-500/20 bg-amber-500/15 text-amber-200";
    if (item.kind === "issue_mention") return "border-emerald-500/20 bg-emerald-500/15 text-emerald-200";
    return "border-rose-500/20 bg-rose-500/15 text-rose-200";
  }

  function notificationTypeLabel(value: string): string {
    const labels: Record<string, string> = {
      "": "All",
      pr_review_request: "PR review",
      pr_comment: "PR comment",
      pr_review_comment: "PR review comment",
      issue_assigned: "Issue assigned",
      issue_mention: "Issue mention",
      issue_comment: "Issue comment",
    };
    return labels[value] || "All";
  }

  function isCommentNotification(item: WatchItem): boolean {
    return item.kind.endsWith("_comment");
  }
</script>

<svelte:head>
  <title>GHE Notification Watch</title>
</svelte:head>

<Tooltip.Provider>
  <header
    class="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border bg-card/95 px-4 py-2 shadow-sm backdrop-blur"
  >
    <div>
      <h1 class="m-0 text-base font-semibold">GHE Notification Watch</h1>
      <p class="mt-0.5 text-xs text-muted-foreground">
        {connection} · {filteredItems.length} visible / {items.length} tracked · {lastUpdated} · {cacheLabel}
        {#if mutedRepos.length}
          · {mutedRepos.length} muted repos
        {/if}
      </p>
    </div>
    <div class="flex flex-wrap justify-end gap-2">
      <Button variant="outline" onclick={refresh}>
        <RefreshCwIcon data-icon="inline-start" />
        Refresh
      </Button>
      <Button variant="outline" onclick={copyDigest}>
        <CopyIcon data-icon="inline-start" />
        Copy digest
      </Button>
      <Button variant="outline" onclick={enableNotifications}>
        <BellIcon data-icon="inline-start" />
        {notificationLabel}
      </Button>
    </div>
  </header>

  <main class="mx-auto max-w-[1280px] px-4 py-3">
    <section
      class="mb-3 grid grid-cols-[minmax(240px,1fr)_180px_auto] items-end gap-3 max-md:grid-cols-1"
      aria-label="Filters"
    >
      <label class="grid gap-1 text-xs text-muted-foreground">
        Search
        <Input type="search" bind:value={query} placeholder="repo, title, actor" />
      </label>
      <label class="grid gap-1 text-xs text-muted-foreground">
        Type
        <Select.Root type="single" bind:value={kind}>
          <Select.Trigger class="w-full">
            <span data-slot="select-value">{notificationTypeLabel(kindValue)}</span>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="">All</Select.Item>
            <Select.Item value="pr_review_request">PR review</Select.Item>
            <Select.Item value="pr_comment">PR comment</Select.Item>
            <Select.Item value="pr_review_comment">PR review comment</Select.Item>
            <Select.Item value="issue_assigned">Issue assigned</Select.Item>
            <Select.Item value="issue_mention">Issue mention</Select.Item>
            <Select.Item value="issue_comment">Issue comment</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      <div class="flex flex-col justify-end gap-1 text-xs text-muted-foreground">
        <label class="flex items-center gap-2">
          <input class="size-4 rounded border-border bg-background" type="checkbox" bind:checked={showAcknowledged} />
          Show acknowledged ({acknowledgedCount})
        </label>
        <label class="flex items-center gap-2">
          <input class="size-4 rounded border-border bg-background" type="checkbox" bind:checked={showMuted} />
          Show muted ({mutedCount})
        </label>
      </div>
    </section>

    {#if errors.length}
      <section class="mb-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-red-200">
        <strong class="text-red-100">Fetch warnings</strong>
        {#each errors as error (error)}
          <p class="m-0 mt-1 text-red-200">{error}</p>
        {/each}
      </section>
    {/if}

    <section aria-live="polite">
      {@render dashboardTable(pageItems)}
      {#if filteredItems.length > 0}
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <div class="flex items-center gap-2">
            <span>Rows per page</span>
            <Select.Root type="single" bind:value={pageSizeChoice}>
              <Select.Trigger class="h-7 w-[70px]">
                <span data-slot="select-value">{pageSizeChoice}</span>
              </Select.Trigger>
              <Select.Content>
                {#each ["10", "25", "50", "100"] as size (size)}
                  <Select.Item value={size}>{size}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <span>Showing {pageStart}-{pageEnd} of {filteredItems.length}</span>
          </div>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={currentPage <= 1}
              onclick={() => (currentPage = Math.max(1, currentPage - 1))}
            >
              Prev
            </Button>
            <span>Page {currentPage} of {pageCount}</span>
            <Button
              variant="outline"
              size="xs"
              disabled={currentPage >= pageCount}
              onclick={() => (currentPage = Math.min(pageCount, currentPage + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      {/if}
    </section>
  </main>
</Tooltip.Provider>

{#snippet dashboardTable(tableItems: WatchItem[])}
  <section class="min-w-0">
    {#if tableItems.length === 0}
      <p class="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">No matching active items.</p>
    {:else}
      <div class="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <Table.Root class="table-fixed text-xs">
          <colgroup>
            <col class="w-[34px]" />
            <col class="w-[156px]" />
            <col />
            <col class="w-[104px]" />
            <col class="w-[104px]" />
          </colgroup>
          <Table.Header class="bg-muted/50 text-muted-foreground">
            <Table.Row>
              <Table.Head class="px-1 py-2 text-xs"><span class="sr-only">Details</span></Table.Head>
              <Table.Head class="px-2 py-2 text-xs">Type</Table.Head>
              <Table.Head class="px-2 py-2 text-xs">Title</Table.Head>
              <Table.Head class="px-2 py-2 text-right text-xs">Updated</Table.Head>
              <Table.Head class="px-2 py-2 text-xs">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each tableItems as item (item.id)}
              <Table.Row
                class="border-l-[3px] {item.lifecycle === 'acknowledged'
                  ? 'border-l-muted-foreground/30 bg-black opacity-50 grayscale'
                  : typeClass(item)}"
              >
                <Table.Cell class="overflow-hidden px-1 py-2 align-top">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={isExpanded(item.id) ? "Hide details" : "Show details"}
                    aria-expanded={isExpanded(item.id)}
                    aria-controls={detailsRegionId(item)}
                    onclick={() => toggleDetails(item)}
                  >
                    {#if isExpanded(item.id)}
                      <ChevronDownIcon />
                    {:else}
                      <ChevronRightIcon />
                    {/if}
                  </Button>
                </Table.Cell>
                <Table.Cell class="overflow-hidden px-2 py-2 align-top">
                  <Badge variant="outline" class={typeBadgeClass(item)}>{notificationTypeLabel(item.kind)}</Badge>
                </Table.Cell>
                <Table.Cell class="overflow-hidden px-2 py-2 align-top">
                  <span class="mb-0.5 flex items-center gap-1.5 text-muted-foreground">
                    <span class="truncate" title={`${item.repoName} #${item.number}`}>
                      {item.repoName} #{item.number}
                    </span>
                    {#if isDependencyBotItem(item)}
                      <Badge variant="outline" class="shrink-0 border-orange-500/30 bg-orange-500/15 text-orange-300">
                        dependabot
                      </Badge>
                    {/if}
                  </span>
                  <a
                    class="block truncate text-foreground hover:text-primary hover:underline"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    title={item.title}
                  >
                    {item.title}
                  </a>
                </Table.Cell>
                <Table.Cell
                  class="overflow-hidden whitespace-nowrap px-2 py-2 text-right align-top text-muted-foreground"
                  >{formatDate(item.updatedAt)}</Table.Cell
                >
                <Table.Cell class="overflow-hidden px-2 py-2 align-top">
                  <div class="flex flex-nowrap gap-1">
                    <Tooltip.Root>
                      <Tooltip.Trigger>
                        {#snippet child({ props })}
                          <Button
                            {...props}
                            size="icon-xs"
                            variant="outline"
                            aria-label={item.lifecycle === "acknowledged"
                              ? "Un-acknowledge locally"
                              : "Acknowledge locally"}
                            aria-pressed={item.lifecycle === "acknowledged"}
                            onclick={() => setAck(item.id, item.lifecycle !== "acknowledged")}
                          >
                            {#if item.lifecycle === "acknowledged"}
                              <CircleCheckIcon class="fill-primary text-primary-foreground" />
                            {:else}
                              <CircleCheckIcon />
                            {/if}
                          </Button>
                        {/snippet}
                      </Tooltip.Trigger>
                      <Tooltip.Content
                        >{item.lifecycle === "acknowledged"
                          ? "Acknowledged (click to undo)"
                          : "Acknowledge locally"}</Tooltip.Content
                      >
                    </Tooltip.Root>
                    {#if item.kind.startsWith("pr_")}
                      <Tooltip.Root>
                        <Tooltip.Trigger>
                          {#snippet child({ props })}
                            <Button
                              {...props}
                              size="icon-xs"
                              variant="outline"
                              aria-label="Copy agent review prompt"
                              disabled={copyingReviewPromptId === item.id}
                              onclick={() => copyAgentReviewPrompt(item.id)}
                            >
                              <BotIcon />
                            </Button>
                          {/snippet}
                        </Tooltip.Trigger>
                        <Tooltip.Content
                          >{copiedReviewPromptId === item.id ? "Copied prompt" : "Copy agent prompt"}</Tooltip.Content
                        >
                      </Tooltip.Root>
                      <Tooltip.Root>
                        <Tooltip.Trigger>
                          {#snippet child({ props })}
                            <Button
                              {...props}
                              size="icon-xs"
                              variant="outline"
                              aria-label="Open review terminal"
                              disabled={openingTerminalId === item.id}
                              onclick={() => openReviewTerminal(item.id)}
                            >
                              <SquareTerminalIcon />
                            </Button>
                          {/snippet}
                        </Tooltip.Trigger>
                        <Tooltip.Content>Open terminal with the PR branch checked out</Tooltip.Content>
                      </Tooltip.Root>
                    {/if}
                  </div>
                </Table.Cell>
              </Table.Row>
              {#if isExpanded(item.id)}
                <Table.Row class="border-l-[3px] {typeClass(item)} bg-muted/20">
                  <Table.Cell colspan={5} class="whitespace-normal px-3 py-3 align-top">
                    {@render detailPanel(item)}
                  </Table.Cell>
                </Table.Row>
              {/if}
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    {/if}
  </section>
{/snippet}

{#snippet detailPanel(item: WatchItem)}
  {@const detailState = detailsById[item.id]}
  <div id={detailsRegionId(item)} class="grid gap-3 text-xs">
    <dl class="grid gap-x-3 gap-y-1 text-muted-foreground sm:grid-cols-[80px_minmax(0,1fr)_80px_minmax(0,1fr)]">
      <dt>Actor</dt>
      <dd class="min-w-0 truncate text-foreground">{item.actor}</dd>
      <dt>Lifecycle</dt>
      <dd class="text-foreground">{item.lifecycle}</dd>
      <dt>Created</dt>
      <dd class="text-foreground">{formatDate(item.createdAt)}</dd>
      <dt>Updated</dt>
      <dd class="text-foreground">{formatDate(item.updatedAt)}</dd>
      {#if item.baseBranch || item.headBranch}
        <dt>Branch</dt>
        <dd class="min-w-0 truncate text-foreground sm:col-span-3">
          {item.headBranch || "unknown"} → {item.baseBranch || "unknown"}
        </dd>
      {/if}
    </dl>

    {#if item.labels.length}
      <div class="flex flex-wrap gap-1">
        {#each item.labels as label (label)}
          <Badge variant="outline">{label}</Badge>
        {/each}
      </div>
    {/if}

    <div class="flex flex-wrap gap-2">
      <Button size="xs" variant="outline" onclick={() => setRepoMuted(item.repo, !mutedRepos.includes(item.repo))}>
        <BellOffIcon data-icon="inline-start" />
        {mutedRepos.includes(item.repo) ? `Unmute ${item.repoName}` : `Mute ${item.repoName}`}
      </Button>
    </div>

    {#if !detailState || detailState.status === "loading"}
      <p class="m-0 text-muted-foreground">Loading details...</p>
    {:else if detailState.status === "error"}
      <p class="m-0 text-destructive">Details unavailable: {detailState.error}</p>
    {:else if isCommentNotification(item)}
      {@const comment = detailState.details.comments[0]}
      <section class="grid gap-2">
        <h2 class="text-xs font-semibold text-foreground">Comment</h2>
        <article class="grid gap-1 rounded-sm border border-border bg-background/60 p-2">
          <div class="flex min-w-0 items-center justify-between gap-3 text-muted-foreground">
            <span class="min-w-0 truncate text-foreground">{comment?.author || item.actor}</span>
            <a
              class="shrink-0 hover:text-primary hover:underline"
              href={comment?.url || item.url}
              target="_blank"
              rel="noreferrer"
            >
              {formatDate(comment?.updatedAt || item.updatedAt)}
            </a>
          </div>
          <div class="rich-text text-muted-foreground">
            <!-- Escaped and stripped by sanitizeHtml in src/rich-text.ts (scripts, event handlers
                 and javascript: hrefs removed); see test/rich-text.test.ts. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderRichText(comment?.body || item.summary || "No comment body.")}
          </div>
        </article>
      </section>
    {:else}
      <section class="grid gap-2">
        <h2 class="text-xs font-semibold text-foreground">Body</h2>
        <div
          class="rich-text max-h-48 overflow-auto rounded-sm border border-border bg-background/60 p-2 text-muted-foreground"
        >
          <!-- Sanitized: see src/rich-text.ts. -->
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderRichText(detailState.details.body || "No body.")}
        </div>
      </section>

      <section class="grid gap-2">
        <h2 class="text-xs font-semibold text-foreground">Comments</h2>
        {#if detailState.details.comments.length}
          <div class="grid max-h-72 gap-2 overflow-auto pr-1">
            {#each detailState.details.comments as comment (comment.id)}
              <article class="grid gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div class="flex min-w-0 items-center justify-between gap-3 text-muted-foreground">
                  <span class="min-w-0 truncate text-foreground">{comment.author}</span>
                  <a
                    class="shrink-0 hover:text-primary hover:underline"
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {formatDate(comment.updatedAt)}
                  </a>
                </div>
                <div class="rich-text text-muted-foreground">
                  <!-- Sanitized: see src/rich-text.ts. -->
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  {@html renderRichText(comment.body || "No comment body.")}
                </div>
              </article>
            {/each}
          </div>
        {:else}
          <p class="m-0 text-muted-foreground">No comments.</p>
        {/if}
      </section>
    {/if}
  </div>
{/snippet}
