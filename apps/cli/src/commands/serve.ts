// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { parseArgs } from "../args.js";
import { createDrafter, DEFAULT_DRAFT_MODEL, type Drafter, type DraftingClient } from "../drafting.js";
import { DEFAULT_ORIGIN, DEFAULT_PORT, startTraceServer } from "../serve.js";

/** The one variable drafting reads a key from. A saved profile is not a decision to spend. */
export const DRAFTING_KEY_VARIABLE = "ANTHROPIC_API_KEY";

/**
 * Serves a directory of trace files over HTTP: `GET /runs`, and an SSE stream
 * per run that replays the file and then follows it.
 *
 * Standalone, this is a replay server and nothing more. No run is executing
 * behind it, so it is started without a gate resolver and every gate decision it
 * is offered comes back refused. That is the honest answer; the alternative is a
 * 202 for a decision nobody will ever act on.
 *
 * With `--drafting`, and only with a key in the environment as well, it also
 * answers `POST /draft`: the canvas's hopper sends a brain dump and the spec,
 * and gets back candidate steps, checked (see drafting.ts). The key stays in
 * this process; the browser never sees it. Without the flag the route is a 404
 * that says how to turn it on, and no model is ever called.
 */
export function serveCommand(
  args: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const { values, positionals } = parseArgs("serve", {
    args,
    options: {
      port: { type: "string", default: String(DEFAULT_PORT) },
      host: { type: "string", default: "127.0.0.1" },
      /** The one origin allowed to read these traces from a browser. */
      origin: { type: "string", default: DEFAULT_ORIGIN },
      /** Answer the canvas's hopper. Needs ANTHROPIC_API_KEY as well. */
      drafting: { type: "boolean", default: false },
      "draft-model": { type: "string" },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  const dir = positionals[0];
  if (!dir) {
    process.stderr.write("ccg serve: no directory given (a folder of .jsonl trace files)\n");
    return 2;
  }
  try {
    if (!statSync(dir).isDirectory()) {
      process.stderr.write(`ccg serve: ${dir} is not a directory\n`);
      return 2;
    }
  } catch {
    process.stderr.write(`ccg serve: cannot read ${dir}\n`);
    return 2;
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write("ccg serve: --port must be a whole number from 0 to 65535\n");
    return 2;
  }

  const key = env[DRAFTING_KEY_VARIABLE] ?? "";
  if (values.drafting && key === "") {
    process.stderr.write(
      `ccg serve: --drafting needs ${DRAFTING_KEY_VARIABLE} in the environment. ` +
        "It stays with this server and is never sent to the browser.\n",
    );
    return 2;
  }
  const model = values["draft-model"] ?? (env.CCG_DRAFT_MODEL || DEFAULT_DRAFT_MODEL);

  // The dispatcher in index.ts is synchronous, so binding cannot be awaited
  // here. A bind failure sets the exit code itself; with no listener holding it
  // open, the process then exits on its own with that code.
  const drafter: Promise<Drafter | undefined> = values.drafting
    ? anthropicClient().then((client) =>
        createDrafter({
          client,
          model,
          secrets: [key],
          log: (line) => process.stderr.write(`ccg serve: ${line}\n`),
        }),
      )
    : Promise.resolve(undefined);

  drafter
    .then((draft) => startTraceServer({ dir, port, host: values.host, origin: values.origin, draft }))
    .then((server) => {
      process.stderr.write(`ccg serve: ${server.url} — replaying ${dir}\n`);
      process.stderr.write(`  GET  /runs\n  GET  /runs/<id>/events   (SSE, resumes on Last-Event-ID)\n`);
      if (values.drafting) {
        process.stderr.write(
          `  POST /draft               (drafting with ${model}: sends the brain dump and the spec to the Anthropic API)\n`,
        );
      }
      process.stderr.write(`  CORS: ${values.origin}\n`);
      process.stderr.write("  gate decisions are refused: no live run is attached to a replay\n");
    })
    .catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`ccg serve: ${key === "" ? message : message.split(key).join("[redacted]")}\n`);
      process.exitCode = 2;
    });

  return 0;
}

/**
 * The real client, constructed the documented way. Imported only here, and
 * only once `--drafting` and a key are both present, so a server without them
 * never loads the SDK at all.
 */
async function anthropicClient(): Promise<DraftingClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}
