import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Forward /router -> http://127.0.0.1:8701/rpc
      "/router": {
        target: "http://127.0.0.1:8701",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/router/, "/rpc")
      },
      // Forward /platform -> http://127.0.0.1:8721/rpc
      "/platform": {
        target: "http://127.0.0.1:8721",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/platform/, "/rpc")
      }
    }
  },
  build: {
    sourcemap: true
  }
});