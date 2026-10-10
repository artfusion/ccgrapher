// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManagedAgentsClient } from "./client.js";
import { LockError, parseLock, type ClaudeLock } from "./lock.js";

/** The environment variables that count as credentials here. Nothing else does. */
export const CREDENTIAL_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * A real Anthropic client, or `undefined` when the environment names no
 * credentials.
 *
 * Deliberately narrower than the SDK's own chain, which would also fall back to
 * a profile saved by `ant auth login`. A profile left on a machine is not a
 * decision to spend from it, so this asks for a key or token in the environment
 * of the one command that will use it. With one present the SDK is imported and
 * constructed the documented way, `new Anthropic()`, which reads the same two
 * variables. Without one, the SDK is never even loaded.
 */
export async function clientFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ManagedAgentsClient | undefined> {
  if (!CREDENTIAL_VARIABLES.some((name) => (env[name] ?? "") !== "")) return undefined;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}

/** `claude-lock.json` from the generated directory, read and checked. */
export function readLock(dir: string): ClaudeLock {
  const path = join(dir, "claude-lock.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new LockError(
      `${path} does not exist. Apply the generated files with ant apply from ${dir}, which writes it, before running.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LockError(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseLock(value, path);
}
