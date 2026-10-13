import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/kb-assets": { target: process.env.VITE_API_ORIGIN ?? "http://localhost:4000", changeOrigin: true },
      "/api": { target: process.env.VITE_API_ORIGIN ?? "http://localhost:4000", changeOrigin: true },
    },
  },
});
