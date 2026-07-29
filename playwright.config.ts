import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://localhost:3847",
    trace: "retain-on-failure",
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
});
