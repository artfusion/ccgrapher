// SPDX-License-Identifier: Apache-2.0
import { parseArgs as nodeParseArgs, type ParseArgsConfig } from "node:util";

/**
 * Bad usage, as the README defines it: exit 2.
 *
 * Distinct from SpecError, which also exits 2 but means the spec was
 * unreadable rather than the command line being wrong.
 */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * `node:util` parseArgs, with its exceptions turned into UsageError.
 *
 * parseArgs throws a TypeError for an unknown option, a missing value, or a
 * value where none was expected. Thrown from inside a command it reached the
 * top of the process untouched, so a mistyped flag printed a Node stack trace
 * and exited 1 — the code that means "this workflow has lint errors". A typo
 * was therefore indistinguishable from a failing check to anything reading
 * exit codes, which is exactly what CI does.
 *
 * Every command parses through here so that all of them agree.
 *
 * Generic over the config so that parseArgs' own inference survives the
 * wrapper: widening it to ParseArgsConfig turns every parsed value back into
 * `string | boolean | (string | boolean)[] | undefined` at the call sites.
 */
export function parseArgs<const T extends ParseArgsConfig>(command: string, config: T) {
  try {
    return nodeParseArgs(config);
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string" &&
      cause.code.startsWith("ERR_PARSE_ARGS_")
    ) {
      // parseArgs' own message names the offending flag, then advises how to
      // pass a positional beginning with a dash. That advice is noise for
      // someone who simply mistyped, so keep the first sentence and say which
      // command rejected it. Messages without a sentence break, such as
      // "option '--json' does not take an argument", survive intact.
      const first = cause.message.split(/\.\s/)[0]?.trim() ?? "bad arguments";
      throw new UsageError(`ccg ${command}: ${lowerFirst(first)}`);
    }
    throw cause;
  }
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}
