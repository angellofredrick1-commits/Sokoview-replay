import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        replay: resolve(__dirname, "replay.html"),
        capture: resolve(__dirname, "capture.html"),
        report: resolve(__dirname, "report.html"),
        stock: resolve(__dirname, "stock.html"),
        dividends: resolve(__dirname, "dividends.html"),
        portfolio: resolve(__dirname, "portfolio.html"),
      },
    },
  },
});
