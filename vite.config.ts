import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Use BASE_PATH only for production build (GitHub Pages).
  // Keep dev server rooted at "/" to avoid blank pages locally.
  base: command === "build" ? process.env.BASE_PATH || "/" : "/"
}));
