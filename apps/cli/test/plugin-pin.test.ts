// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const cliVersion = (JSON.parse(read("apps/cli/package.json")) as { version: string }).version;

// The plugin tells Claude to run the CLI through npx. The directory requires
// that to be an exact version, and an exact version goes stale on every release,
// so this fails the build when the two drift.
const files = ["plugin/skills/parallel-plan/SKILL.md", "plugin/README.md"];

describe("the plugin's pinned @ccgrapher/cli version", () => {
  for (const file of files) {
    it(`${file} pins every use to ${cliVersion}`, () => {
      const uses = [...read(file).matchAll(/@ccgrapher\/cli(?:@(\d+\.\d+\.\d+(?:-[\w.]+)?))?/g)];
      expect(uses.length, `${file} no longer mentions the CLI`).toBeGreaterThan(0);
      for (const use of uses) {
        expect(use[1], `${file}: bump the pin to @ccgrapher/cli@${cliVersion}`).toBe(cliVersion);
      }
    });
  }
});
