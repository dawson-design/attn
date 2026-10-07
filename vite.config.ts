import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineConfig } from "vite";
import { loadConfig } from "./src/config";
import { ensureCertificate, tlsPath } from "./src/tls";

export default defineConfig(({ command }) => {
  // The dev server serves https://attn.localhost:<port> with the dev state
  // directory's certificate; `bun run cli setup https` trusts it.
  const https = command === "serve" ? devCertificate() : undefined;
  return {
    plugins: [tailwindcss(), sveltekit()],
    server: {
      host: "127.0.0.1",
      port: Number(process.env.ATTN_PORT || 8765),
      https,
      // Fail instead of moving to the next port: the dashboard's address and
      // `attn open` name the configured port.
      strictPort: true,
    },
  };
});

function devCertificate(): { key: string; cert: string } {
  const stateFile = loadConfig().stateFile;
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const { key, cert } = ensureCertificate(tlsPath(stateFile));
  return { key, cert };
}
