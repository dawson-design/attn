import { json, text, type Handle, type ServerInit } from "@sveltejs/kit";
import { dirname } from "node:path";
import { agentSocketPath } from "./attn-client";
import { isAuthenticated, isPublicRequest, wantsLockedPage } from "./auth";
import { loadConfig } from "./config";
import { classifyHost, isAllowedRequestOrigin } from "./host-guard";
import { closeAgentSocket, listenAgentSocket, type AgentBackend } from "./lib/server/agent-socket";
import { authState, startAuthState, type AuthState } from "./lib/server/auth-state";
import { getDashboardService } from "./lib/server/dashboard";
import { holdIpv6Loopback } from "./lib/server/ipv6-loopback";
import { LOCKED_PAGE } from "./locked-page";
import { ensurePrivateDir } from "./private-file";
import { SessionStore } from "./sessions";

interface Listeners {
  close(): Promise<void>;
}

declare global {
  var attnListeners: Promise<Listeners> | undefined;
  // Called by `attn serve` on SIGTERM/SIGINT.
  var attnShutdown: (() => Promise<void>) | undefined;
}

function agentBackend(auth: AuthState): AgentBackend {
  return {
    items: async () => (await getDashboardService()).getSnapshot(),
    acknowledge: async (ids, acknowledged) => (await getDashboardService()).acknowledge(ids, acknowledged),
    reviewPrompt: async (id) => (await (await getDashboardService()).buildAgentReviewPrompt(id)).prompt,
    // Agents never override the rate-limit backoff; only a click does.
    refresh: async () => (await getDashboardService()).refresh({ force: false }),
    signInUrl: () => `${auth.origin}/#code=${auth.loginCodes.issue()}`,
    signOut: async () => {
      const revoked = auth.sessions.revokeAll();
      (await globalThis.attnService)?.closeClients();
      return revoked;
    },
  };
}

async function startListeners(port: number, socketPath: string, auth: AuthState): Promise<Listeners> {
  const ipv6 = await holdIpv6Loopback(port);
  try {
    const socket = await listenAgentSocket(socketPath, agentBackend(auth));
    return {
      close: async () => {
        ipv6.close();
        await closeAgentSocket(socket, socketPath);
      },
    };
  } catch (error) {
    ipv6.close();
    throw error;
  }
}

export const init: ServerInit = async () => {
  const config = loadConfig();
  // Tighten a state directory created before files were written owner-only;
  // the agent socket and tls.pem depend on it.
  await ensurePrivateDir(dirname(config.stateFile));
  const auth = startAuthState(config.port, new SessionStore());
  globalThis.attnListeners ??= startListeners(config.port, agentSocketPath(config.stateFile), auth);
  // A failed start must not stay cached, or a dev server keeps failing.
  const listeners = await globalThis.attnListeners.catch((error: unknown) => {
    globalThis.attnListeners = undefined;
    throw error;
  });
  // The dashboard's event streams never end on their own, so shutdown closes
  // them, stops polling, and closes the socket and the [::1] listener. It
  // only stops a service that exists, so it never starts one (and gh) to stop it.
  globalThis.attnShutdown = async () => {
    (await globalThis.attnService)?.dispose();
    await listeners.close();
  };
};

function withSecurityHeaders(response: Response): Response {
  // HSTS keeps browsers that honor it for localhost names from offering a
  // click-through on a TLS error (Chrome does not; see sessions.ts). The rest
  // is defense in depth: no framing (clickjacking of the ack / terminal
  // buttons), no MIME sniffing, and no referrer leaking local URLs.
  response.headers.set("Strict-Transport-Security", "max-age=31536000");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  const auth = authState();
  const request = event.request;
  const host = classifyHost(request.headers.get("host") ?? "", auth.host);
  if (host === "foreign") {
    return withSecurityHeaders(
      text("Forbidden: unexpected Host header. This dashboard only serves loopback requests.\n", { status: 403 }),
    );
  }

  // Data and actions need a session token, and sessions only work on
  // attn.localhost. Other loopback names get the locked page.
  const { pathname } = event.url;
  // SvelteKit reports a page's __data.json request with the page's own path,
  // so a data request is never public, even for the page shell.
  const isPublic = !event.isDataRequest && isPublicRequest(request.method, pathname);
  const allowed =
    host === "dashboard" && (isPublic || isAuthenticated(request.headers.get("authorization"), auth.sessions));
  if (!allowed) {
    if (wantsLockedPage(request.method, pathname)) {
      return withSecurityHeaders(
        new Response(LOCKED_PAGE, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      );
    }
    return withSecurityHeaders(json({ ok: false, error: "Not signed in. Run `attn open`." }, { status: 401 }));
  }

  // Reject cross-site state-changing requests (CSRF). See host-guard.ts.
  if (
    !isAllowedRequestOrigin(
      request.method,
      request.headers.get("sec-fetch-site"),
      request.headers.get("origin"),
      auth.origin,
    )
  ) {
    return withSecurityHeaders(text("Forbidden: cross-origin request rejected.\n", { status: 403 }));
  }

  return withSecurityHeaders(await resolve(event));
};
