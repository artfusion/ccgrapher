#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { appendHook } from "./append.js";
import type { HookPayload } from "./map.js";

function warn(message: string): void {
  process.stderr.write(`ccg-claude-code-hook: ${message}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const text = await readStdin();
  if (text.trim() === "") {
    warn("nothing arrived on stdin — this is meant to be run by a Claude Code hook");
    return 1;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    warn(`stdin is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    warn("stdin parsed, but a hook payload is a JSON object and this is not one");
    return 1;
  }
  // Without an override the run lands in `runs/` under the session's own
  // project directory, which is where `ccg serve` and `ccg trace stats` look.
  const dir = process.env["CCG_TRACE_DIR"];
  appendHook(payload as HookPayload, dir !== undefined && dir !== "" ? { dir } : {});
  return 0;
}

/**
 * Exit 1 on failure, never 2.
 *
 * Claude Code reads 2 from a hook as "block this", so an adapter that failed to
 * write a line would go on to stop the tool call it was only supposed to be
 * recording. Recording a session must not be able to change it. 1 still shows
 * the message, which is the other half: a trace quietly missing events is worse
 * than a visible complaint.
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    warn(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
