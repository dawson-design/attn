import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { agentSocketPath, AttnNotRunningError, socketAttnClient, UntrustedSocketError } from "../src/attn-client";
import { closeAgentSocket, listenAgentSocket, type AgentBackend } from "../src/lib/server/agent-socket";
import type { Snapshot } from "../src/types";

const snapshot: Snapshot = {
  generatedAt: "2026-10-06T00:00:00Z",
  host: "github.com",
  items: [],
  errors: [],
  cacheStatus: "fresh",
};

class FakeBackend implements AgentBackend {
  acks: Array<{ ids: string[]; acknowledged: boolean }> = [];
  refreshes = 0;
  signOuts = 0;
  async items() {
    return snapshot;
  }
  async acknowledge(ids: string[], acknowledged: boolean) {
    this.acks.push({ ids, acknowledged });
  }
  async reviewPrompt(id: string) {
    if (id === "missing") throw new Error("Notification item was not found in the current snapshot.");
    return `Review ${id}`;
  }
  async refresh() {
    this.refreshes += 1;
    return snapshot;
  }
  signInUrl() {
    return "https://attn.localhost:8765/#code=xyz";
  }
  async signOut() {
    this.signOuts += 1;
    return 2;
  }
}

describe("agent socket", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  let socketPath = "";
  afterEach(async () => {
    if (server) await closeAgentSocket(server, socketPath);
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function stateDir(): Promise<string> {
    // Short base path: Unix socket paths are limited to 104 bytes on macOS.
    dir = await mkdtemp("/tmp/attn-sock-");
    await chmod(dir, 0o700);
    socketPath = agentSocketPath(`${dir}/state.json`);
    return dir;
  }

  async function serve(backend: AgentBackend = new FakeBackend()): Promise<AgentBackend> {
    await stateDir();
    server = await listenAgentSocket(socketPath, backend);
    return backend;
  }

  test("the client reaches every agent route over the socket", async () => {
    const backend = (await serve()) as FakeBackend;
    const client = socketAttnClient(socketPath);
    expect(await client.items()).toEqual(snapshot);
    await client.acknowledge(["a", "b"], false);
    expect(backend.acks).toEqual([{ ids: ["a", "b"], acknowledged: false }]);
    expect(await client.reviewPrompt("a")).toBe("Review a");
    await client.refresh();
    expect(backend.refreshes).toBe(1);
    expect(await client.signInUrl()).toBe("https://attn.localhost:8765/#code=xyz");
    expect(await client.signOutAll()).toBe(2);
  });

  test("only this user can open the socket", async () => {
    await serve();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  test("surfaces the server's error message", async () => {
    await serve();
    await expect(socketAttnClient(socketPath).reviewPrompt("missing")).rejects.toThrow("was not found");
  });

  test("reports not running when there is no socket", async () => {
    await stateDir();
    await expect(socketAttnClient(socketPath).items()).rejects.toBeInstanceOf(AttnNotRunningError);
  });

  test("reports not running when a crashed server left its socket behind, and a new server replaces it", async () => {
    await stateDir();
    // A process that exits without closing its listener leaves a dead socket file.
    const script = `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(0))`;
    Bun.spawnSync([process.execPath, "-e", script]);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await expect(socketAttnClient(socketPath).items()).rejects.toBeInstanceOf(AttnNotRunningError);
    server = await listenAgentSocket(socketPath, new FakeBackend());
    expect(await socketAttnClient(socketPath).items()).toEqual(snapshot);
  });

  test("a second server refuses to take over a live socket", async () => {
    await serve();
    await expect(listenAgentSocket(socketPath, new FakeBackend())).rejects.toThrow("already running");
    expect(await socketAttnClient(socketPath).items()).toEqual(snapshot);
  });

  test("refuses a socket in a directory other accounts can write to", async () => {
    await serve();
    await chmod(dir!, 0o777);
    await expect(socketAttnClient(socketPath).items()).rejects.toBeInstanceOf(UntrustedSocketError);
    await chmod(dir!, 0o700);
  });

  test("refuses a file that is not a socket", async () => {
    await stateDir();
    await writeFile(socketPath, "not a socket");
    await expect(socketAttnClient(socketPath).items()).rejects.toBeInstanceOf(UntrustedSocketError);
  });

  test("refuses a socket path longer than macOS allows, with a clear error", async () => {
    await stateDir();
    await expect(listenAgentSocket(`${dir}/${"x".repeat(120)}.sock`, new FakeBackend())).rejects.toThrow(
      "longer than macOS allows",
    );
  });

  test("rejects unknown routes and malformed bodies", async () => {
    await serve();
    const call = (method: string, path: string, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = request({ socketPath, method, path }, (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        });
        outgoing.on("error", reject);
        outgoing.end(body);
      });
    expect(await call("GET", "/nope")).toBe(404);
    expect(await call("POST", "/ack", "{not json")).toBe(400);
    expect(await call("POST", "/review-prompt", "{}")).toBe(400);
  });
});
