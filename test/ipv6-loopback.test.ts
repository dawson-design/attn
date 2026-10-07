import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { holdIpv6Loopback, type Ipv6Hold } from "../src/lib/server/ipv6-loopback";

describe("holdIpv6Loopback", () => {
  let upstream: Server | undefined;
  let hold: Ipv6Hold | undefined;
  afterEach(() => {
    hold?.close();
    upstream?.close();
    hold = undefined;
    upstream = undefined;
  });

  async function serveIpv4(): Promise<number> {
    upstream = createHttpServer((request, response) => response.end(`ipv4 saw ${request.headers.host}`));
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    return (upstream.address() as { port: number }).port;
  }

  test("a browser that connects to [::1] reaches the server on 127.0.0.1 with its Host intact", async () => {
    const port = await serveIpv4();
    hold = await holdIpv6Loopback(port);
    const response = await fetch(`http://[::1]:${port}/`, { headers: { host: `attn-x.localhost:${port}` } });
    expect(await response.text()).toBe(`ipv4 saw attn-x.localhost:${port}`);
  });

  test("no other program can bind [::1] on the port while attn holds it", async () => {
    const port = await serveIpv4();
    hold = await holdIpv6Loopback(port);
    const squatter = createTcpServer();
    const code = await new Promise<string>((resolve) => {
      squatter.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
      squatter.listen({ host: "::1", port, ipv6Only: true }, () => resolve("bound"));
    });
    squatter.close();
    expect(code).toBe("EADDRINUSE");
  });

  test("refuses to start when another program already holds [::1] on the port", async () => {
    const port = await serveIpv4();
    const squatter = createTcpServer();
    await new Promise<void>((resolve) => squatter.listen({ host: "::1", port, ipv6Only: true }, resolve));
    try {
      await expect(holdIpv6Loopback(port)).rejects.toThrow(`Port ${port} is already in use on [::1]`);
    } finally {
      squatter.close();
    }
  });
});
