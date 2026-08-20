import react from "@vitejs/plugin-react";
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
  },
});
