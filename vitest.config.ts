import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}"],
    // Default environment stays "node" — everything but the web app's
    // component tests wants no DOM at all. Those opt into jsdom per file
    // with a `// @vitest-environment jsdom` docblock instead of paying for
    // a DOM everywhere.
    environment: "node",
    // The Anthropic SDK is unloadable in every test, whoever imports it:
    // nothing here may reach a real account.
    alias: {
      "@anthropic-ai/sdk": fileURLToPath(new URL("./tools/anthropic-sdk-disabled.ts", import.meta.url)),
    },
  },
});
