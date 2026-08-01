// SPDX-License-Identifier: Apache-2.0

/**
 * A fan-in guard was not met, so the run stopped.
 *
 * This is the reason this package exists. The generated Claude Code script logs
 * a shortfall and carries on, which means a synthesis step can report on four
 * of five workers' findings and nobody ever learns that the fifth died. Here the
 * same condition ends the run. A count guard that can be ignored is not a guard,
 * it is a comment.
 *
 * `expected` is what the spec declared; `actual` is how many upstream results
 * genuinely arrived. Both are on the error rather than only in the message, so a
 * caller can report the shortfall without parsing English.
 */
export class ExpectsError extends Error {
  override readonly name = "ExpectsError";
  constructor(
    readonly node: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${node}: expected ${expected} upstream result(s), got ${actual}`);
  }
}

/**
 * The graph reached a gate and nobody had been wired up to answer it.
 *
 * Fatal rather than a node failure, because it is a mistake in how the engine
 * was called and not something the workflow did. The alternative — treating an
 * unanswerable gate as a rejection — would quietly turn a missing integration
 * into what looks like a human saying no.
 */
export class MissingGateResolverError extends Error {
  override readonly name = "MissingGateResolverError";
  constructor(readonly node: string) {
    super(`${node}: gate reached but no gate resolver was supplied`);
  }
}

/** A node outlived `timeoutMs`. Ordinary node failure, not fatal: siblings and the rest of the run continue. */
export class NodeTimeoutError extends Error {
  override readonly name = "NodeTimeoutError";
  constructor(
    readonly node: string,
    readonly timeoutMs: number,
    readonly instance?: number,
  ) {
    super(
      `${node}${instance === undefined ? "" : `[${instance}]`}: timed out after ${timeoutMs}ms`,
    );
  }
}

/**
 * Whatever a rejected promise carried, as a sentence.
 *
 * Executors are other people's code and may throw a string, or `undefined`, or
 * an object. The trace contract wants a string, and `String(err)` on a plain
 * object yields "[object Object]", which tells a reader nothing at all.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
