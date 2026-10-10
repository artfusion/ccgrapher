// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from "../args.js";
import { withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { changeLedger, formatLedger, lint, type Ledger } from "@ccgrapher/lint";

/**
 * What changed between two specs, in words: steps, edges, count guards,
 * declarations, which step moved to which wave, and which findings went or
 * came. With one spec, the change is its repair, as `render --pair` draws it.
 *
 * Exits 0 whatever it finds. A change is not a failure; `ccg lint` says
 * whether either spec is sound.
 */
export function diffCommand(args: string[]): number {
  const { values, positionals } = parseArgs("diff", {
    args,
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (positionals.length === 0 || positionals.length > 2) {
    process.stderr.write("ccg diff: takes one spec (as written, then repaired), or two (before, then after)\n");
    return 2;
  }

  const ledger = ledgerFor(positionals[0]!, positionals[1]);
  process.stdout.write(values.json ? `${JSON.stringify(ledger, null, 2)}\n` : `${formatLedger(ledger)}\n`);
  return 0;
}

/**
 * The ledger for a pair: two specs as written, or one spec as written and
 * the same spec with its repaired edges. The same pair `render --pair` draws.
 */
export function ledgerFor(spec: string, revised?: string): Ledger {
  const before = loadGraph(spec);
  const after: Graph = revised === undefined ? withEdges(before, lint(before).repairedEdges) : loadGraph(revised);
  return changeLedger(before, after);
}
