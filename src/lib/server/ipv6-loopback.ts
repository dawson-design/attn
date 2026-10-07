// Holds attn's port on the IPv6 loopback address too.
//
// The server listens on 127.0.0.1, but browsers and macOS resolve
// attn.localhost to ::1 as well, and may try ::1 first. [::1]:<port> is a
// separate socket that any local account could otherwise bind. That program
// could not pass the TLS check, but the browser would stop there and never
// reach attn. attn binds it itself and forwards each connection, byte for
// byte, to 127.0.0.1.
import { connect, createServer, type Socket } from "node:net";

export interface Ipv6Hold {
  close(): void;
}

// Error codes that mean the Mac has no IPv6 loopback, so nobody can bind it.
const NO_IPV6 = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

export async function holdIpv6Loopback(port: number): Promise<Ipv6Hold> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    client.pipe(upstream).pipe(client);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::1", port, ipv6Only: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && NO_IPV6.has(code)) return { close: () => undefined };
    if (code === "EADDRINUSE") {
      throw new Error(
        `Port ${port} is already in use on [::1]: another attn, or another program. ` +
          `See what is listening with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`.`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
