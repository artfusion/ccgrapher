// SPDX-License-Identifier: Apache-2.0
import type { NodeRunState, RunState } from "@ccgrapher/trace";
import type { CCNode as Node } from "./view-model.js";
import { NOT_RECORDED, type DetailRow } from "./run-detail";

/**
 * The capability overlay.
 *
 * Same seam as `applyRunState` and `applyHeat`, and the same rule: layout has
 * already run, and this may only add to `data` and to the presentation of a node
 * that is already where it is. Nothing here reads or writes a position, a width,
 * a height or a rank, nothing reorders the array, and there are no edges in this
 * file at all — a capability is a fact about a step and about the environment it
 * ran in, and it has nothing to say about an arrow between two of them.
 *
 * ── the two sides ──
 *
 * `declared` comes from the spec (`NodeSpec.uses`, carried through `data.uses`);
 * `invoked` comes from the run. They are kept apart because "this node declares
 * no capabilities" and "nothing reported any capability use" are different facts
 * that a single merged list would flatten into one shrug.
 *
 * ── absent is not zero, again ──
 *
 * `CapabilityRunState.available` is tri-state, and this file only ever alerts on
 * an explicit `false`. A capability nothing has reported on is *unknown*, not
 * missing, and tinting a node for one would manufacture an alarm out of a
 * runtime that simply does not emit availability events — which is most of them.
 * Silence never lights anything up here. That is the single rule this file
 * exists to hold.
 */

export type CapabilityAlert = "gap" | "undeclared";

export interface CapabilityState {
  /** What the spec says this node needs. Empty when it declares nothing. */
  readonly declared: readonly string[];
  /** What the run reported this node using, in first-seen order. */
  readonly invoked: readonly string[];
  /** Absent when the two agree, and when nothing is known to be missing. */
  readonly alert?: CapabilityAlert;
}

export interface CapabilityNodeData {
  /** Absent when no run is attached; present on every node once one is. */
  readonly capability?: CapabilityState;
}

/**
 * The two inks, as references rather than as values.
 *
 * `gap` borrows the linter's red: a step is running right now and something it
 * said it needs is reported gone, which is a failure in progress. `undeclared`
 * borrows the gate's amber: the run used something the spec never mentioned,
 * which is a spec that has drifted from its runtime rather than a breakage.
 *
 * Kept as `var(...)` so the palette stays in `globals.css` and this file does
 * not become a second place where the drawing's colours are decided.
 */
const CAPABILITY_INK: Record<CapabilityAlert, string> = {
  gap: "var(--danger)",
  undeclared: "var(--waiting)",
};

/** CSS `content:` takes a quoted string, and a capability id comes from a file. */
function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** At most two ids on the card. The rest are in the note, which has room. */
function caption(prefix: string, ids: readonly string[]): string {
  const shown = ids.slice(0, 2).join(", ");
  return ids.length > 2 ? `${prefix} ${shown} +${ids.length - 2}` : `${prefix} ${shown}`;
}

/**
 * Live, in the strict sense: this node is working *now*.
 *
 * A gap is a present-tense finding — "this step is running and cannot reach
 * something it declared" — so a node that has already finished never raises one,
 * however the environment looked afterwards. Reading a whole run back and
 * pairing each node with the availability at its own moment is a different tool
 * with a different job; this one only ever describes the present.
 */
function working(state: NodeRunState | undefined): boolean {
  return state?.status === "running" || state?.status === "partial";
}

function declaredOf(node: Node): readonly string[] {
  const uses = (node.data as { uses?: readonly string[] }).uses;
  return uses ?? [];
}

/**
 * Mark the nodes whose capabilities are in trouble.
 *
 * Returns the array unchanged when there is no run, because both readings this
 * produces need one: `invoked` comes from a run, and an availability nobody has
 * reported is not a finding. With nothing connected there is nothing to say, so
 * the canvas does not even allocate a new array.
 *
 * The tint reaches the card as two custom properties on the node wrapper, the
 * same route `applyHeat` uses: `--capability-ink` colours the ring and the
 * caption, `--capability-label` is the caption itself. Only an alerting node
 * gets either, so a node with nothing wrong is drawn exactly as it was.
 */
export function applyCapabilityState(nodes: Node[], run: RunState | undefined): Node[] {
  if (!run) return nodes;

  return nodes.map((node) => {
    const declared = declaredOf(node);
    const state = run.nodes.get(node.id);
    const invoked = state?.invoked ?? [];

    // Only `available === false` counts. `undefined` is a capability nobody has
    // looked at, and it stays silent.
    const missing = working(state)
      ? declared.filter((id) => run.capabilities.get(id)?.available === false)
      : [];
    const undeclared = invoked.filter((id) => !declared.includes(id));

    // A gap outranks a drift when both are true. One says a running step is
    // reaching for something that is not there; the other says the spec is out
    // of date. Only the first is happening right now.
    const alert: CapabilityAlert | undefined =
      missing.length > 0 ? "gap" : undeclared.length > 0 ? "undeclared" : undefined;

    const capability: CapabilityState = { declared, invoked, alert };
    // Position, width and height are spread through untouched, on purpose.
    const data = { ...node.data, capability };
    if (!alert) return { ...node, data };

    return {
      ...node,
      className: `${node.className ?? ""} capability-alert capability-${alert}`.trim(),
      style: {
        ...node.style,
        "--capability-ink": CAPABILITY_INK[alert],
        "--capability-label": cssString(
          alert === "gap" ? caption("missing:", missing) : caption("undeclared:", undeclared),
        ),
        // Custom properties are how a tint reaches a card this file does not own.
        // React sets them with `setProperty`, but `CSSProperties` has no room for
        // them in the type, hence the one assertion.
      } as Node["style"],
      data,
    };
  });
}

/**
 * What the spec asked for, against what the run reported using.
 *
 * A declared capability with no reported invocation is `not recorded`, not
 * "unused": plenty of runtimes report no invocations at all, and printing that
 * silence as a finding would be the same lie `run-detail.ts` exists to refuse.
 */
export function declaredRows(
  declared: readonly string[],
  invoked: readonly string[],
): DetailRow[] {
  return declared.map((id) =>
    invoked.includes(id)
      ? { label: id, value: "used", recorded: true }
      : { label: id, value: NOT_RECORDED, recorded: false },
  );
}

/** What the run reported using, and whether the spec ever mentioned it. */
export function invokedRows(declared: readonly string[], invoked: readonly string[]): DetailRow[] {
  return invoked.map((id) => ({
    label: id,
    value: declared.includes(id) ? "declared" : "never declared",
    recorded: true,
  }));
}
