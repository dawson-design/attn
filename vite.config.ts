import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.ATTN_PORT || 8765),
    // Fail instead of moving to the next port: `attn mcp` and `attn open`
    // connect to the configured port.
    strictPort: true,
  },
});
