// vitest/config re-exports Vite's defineConfig with the `test` block
// typed, so this file is one config rather than a vite config plus a
// vitest config that can disagree about the proxy or the plugins.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev server proxies /api and /ws to the event server, so the browser
// talks to one origin and the app never needs to know the server's port.
//
// `secure: false` is not a downgrade: the target is still https, and this
// only tells the *dev proxy* to accept the self-signed certificate that
// scripts/dev-cert.mjs generates. The system-wide decision is https
// everywhere including loopback, and neither api.ts nor ws.ts falls back to
// plaintext — a silent downgrade is worse than a visible connection error.
const EVENT_SERVER = process.env.EVENT_SERVER_ORIGIN ?? "https://127.0.0.1:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: EVENT_SERVER,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: EVENT_SERVER,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    // Matches the server package's layout: tests live beside what they test.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
