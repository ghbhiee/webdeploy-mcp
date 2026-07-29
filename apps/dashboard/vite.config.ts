import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const configuredPath = process.env.WEBDEPLOY_BASE_PATH?.trim() || "/";
  const base = configuredPath === "/" ? "/" : `/${configuredPath.replace(/^\/|\/$/g, "")}/`;
  return {
    base,
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": "http://127.0.0.1:3847",
        "/oauth": "http://127.0.0.1:3847",
        "/.well-known": "http://127.0.0.1:3847",
      },
    },
    build: {
      sourcemap: true,
      target: "es2022",
    },
  };
});
