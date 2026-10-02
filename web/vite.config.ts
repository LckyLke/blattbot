import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vendor chunks, by package. Each group is closed over its own dependencies
 * (none imports back into the app chunk), so splitting cannot create a chunk
 * cycle. react and katex load at boot (the chat renders math) but cache
 * separately from the app code; the rest only load with the lazy panels that
 * use them — without names Rollup would call them "index" or "pdf.worker.min".
 */
const VENDOR_CHUNKS: [name: string, packages: RegExp][] = [
  ["react", /^(react|react-dom|scheduler)$/],
  ["katex", /^katex$/],
  ["pdfjs", /^pdfjs-dist$/],
  ["codemirror", /^(@codemirror\/.*|@lezer\/.*|@marijn\/.*|codemirror|style-mod|w3c-keyname|crelt)$/],
  ["graph", /^(sigma|graphology.*|events|obliterator)$/],
];

/** The npm package a module id belongs to (scoped names included), or null. */
function packageOf(id: string): string | null {
  const match = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id);
  return match ? match[1] : null;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const pkg = packageOf(id);
          if (!pkg) return undefined;
          return VENDOR_CHUNKS.find(([, packages]) => packages.test(pkg))?.[0];
        },
      },
    },
  },
  server: {
    port: 4561,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4560",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
