/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri expects this fixed address (src-tauri/tauri.conf.json).
  server: { host: "127.0.0.1", port: 1430, strictPort: true },
  clearScreen: false,
  build: { target: "safari15" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
