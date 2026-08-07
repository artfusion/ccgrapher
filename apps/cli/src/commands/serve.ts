// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { parseArgs } from "../args.js";
import { DEFAULT_ORIGIN, DEFAULT_PORT, startTraceServer } from "../serve.js";

/**
 * Serves a directory of trace files over HTTP: `GET /runs`, and an SSE stream
 * per run that replays the file and then follows it.
 *
 * Standalone, this is a replay server and nothing more. No run is executing
 * behind it, so it is started without a gate resolver and every gate decision it
 * is offered comes back refused. That is the honest answer; the alternative is a
 * 202 for a decision nobody will ever act on.
 */
export function serveCommand(args: string[]): number {
  const { values, positionals } = parseArgs("serve", {
    args,
    options: {
      port: { type: "string", default: String(DEFAULT_PORT) },
      host: { type: "string", default: "127.0.0.1" },
      /** The one origin allowed to read these traces from a browser. */
      origin: { type: "string", default: DEFAULT_ORIGIN },
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

  // The dispatcher in index.ts is synchronous, so binding cannot be awaited
  // here. A bind failure sets the exit code itself; with no listener holding it
  // open, the process then exits on its own with that code.
  startTraceServer({ dir, port, host: values.host, origin: values.origin })
    .then((server) => {
      process.stderr.write(`ccg serve: ${server.url} — replaying ${dir}\n`);
      process.stderr.write(`  GET  /runs\n  GET  /runs/<id>/events   (SSE, resumes on Last-Event-ID)\n`);
      process.stderr.write(`  CORS: ${values.origin}\n`);
      process.stderr.write("  gate decisions are refused: no live run is attached to a replay\n");
    })
    .catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`ccg serve: ${message}\n`);
      process.exitCode = 2;
    });

  return 0;
}
