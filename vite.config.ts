import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static build only. The /api proxy is NOT Vite's job: it is a Cloudflare
// Pages Function in functions/api/[[path]].ts. For local development use
// `npm run dev` (wrangler pages dev wraps Vite and serves the Function too),
// so the browser always talks same-origin /api exactly like in production.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
