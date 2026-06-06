import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const isWebBuild = process.env.WEB_BUILD === "1";

export default defineConfig({
  plugins: [react()],
  base: isWebBuild ? "/" : "./",
  root: path.resolve(__dirname, "src/renderer"),
  build: {
    outDir: isWebBuild
      ? path.join(__dirname, "dist", "web")
      : path.join(__dirname, "dist", "renderer"),
    emptyOutDir: true,
    rollupOptions: isWebBuild
      ? { input: path.resolve(__dirname, "src/renderer/index-web.html") }
      : undefined
  }
});
