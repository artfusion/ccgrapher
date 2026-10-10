// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * A node is one bounded job with a declared input and a declared output.
 *
 * `goal` is in the enum so a spec can draw an explicit goal node, but the
 * top-level `goal:` string is never turned into one — see `load.ts`. Auto-
 * creating it would push diamond.yaml to five layers and break the "four
 * layers, five workers on one row" acceptance criterion.
 */
export const NodeKind = z.enum([
  "goal",
  "split",
  "worker",
  "verifier",
  "reduce",
  "synthesize",
  "gate",
]);
export type NodeKind = z.infer<typeof NodeKind>;

/**
 * `null` means "plain code, no model, no tokens" — the reduce nodes in
 * research-desk.yaml and linear-chain.yaml rely on this. Absent means
 * unspecified, which the renderer treats as an agent node.
 */
export const ModelTier = z.enum(["cheap", "strong"]).nullable().optional();
export type ModelTier = z.infer<typeof ModelTier>;

/**
 * Shorthand for "run this node once per item in `over`". Does not expand into
 * N graph nodes — it stays one node and renders as a stacked card badged ×cap.
 * `cap` is a maximum, not a promised count.
 */
export const FanOut = z.object({
  over: z.string().min(1),
  cap: z.number().int().positive().optional(),
});
export type FanOut = z.infer<typeof FanOut>;

/** Field name -> freeform type descriptor ("string", "url", "YYYY-MM-DD", "string[]"). */
const FieldMap = z.record(z.string(), z.string());

export const NodeSpec = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: NodeKind,
  model: ModelTier,
  in: FieldMap.default({}),
  out: FieldMap.default({}),
  /** Files or APIs this node touches. Two concurrent nodes sharing one is a hidden edge. */
  writes: z.array(z.string()).optional(),
  /**
   * Capabilities this node depends on: an MCP server, a skill, a plugin, another
   * agent. Opaque namespaced ids — `mcp:<server>/<tool>`, `skill:<name>`,
   * `plugin:<name>`, `agent:<type>` — because what counts as a capability is the
   * runtime's business, not this schema's.
   *
   * Declaring one is a claim, and a claim is auditable: a run either reports the
   * capability was there and used, or it does not, and the difference is a
   * finding rather than a surprise at three in the morning.
   *
   * No commas or whitespace inside an id. The doc comments that carry a spec
   * through codegen and back split traits on commas and ids on spaces, so an id
   * containing either would not survive the round trip.
   */
  uses: z
    .array(z.string().regex(/^[^\s,]+$/, "no commas or whitespace inside a capability id"))
    .optional(),
  /** A verifier that shares context with the worker it grades is self-grading. */
  freshContext: z.boolean().optional(),
  /**
   * Fan-in count guard: how many results this node needs before it may run.
   *
   * The comparison is deliberately not the same at spec time as at run time,
   * and this is the one place that says why.
   *
   * **Spec time** — the linter demands equality. `expects` must equal
   * `effectiveInboundCount`, or SILENT_FAILURE fires. A count that disagrees
   * with the graph is a defect in the spec whichever way it is wrong, and spec
   * time is the moment it can still be corrected.
   *
   * **Run time** — only a shortfall is a violation: `arrivals < expects`.
   * Fewer arrivals than declared means data is genuinely missing, and
   * synthesising on it is precisely the silent failure the guard exists to
   * prevent, so it is fatal. More arrivals than declared means the guard is
   * stale or was miscounted; nothing is missing, and refusing to run on data
   * that is all present is a different and worse error than the stale count —
   * which the linter already reports, where it can be fixed.
   *
   * The run-time comparison is `expectsShortfall`, below, and the two readers
   * that execute in this repository call it: `execute` in `@ccgrapher/runner`
   * before a node runs, and `audit` in `@ccgrapher/lint` over a recorded run
   * afterwards. The guards the `claude-code` and `plain-ts` targets emit cannot
   * call it, since they are strings of source for runtimes this repository
   * never executes. They are held level by tests that pin the surplus case, not
   * by an abstraction.
   */
  expects: z.number().int().nonnegative().optional(),
  fanOut: FanOut.optional(),
  /** Isolated worktree per instance, so parallel workers cannot collide on disk. */
  worktree: z.boolean().optional(),
});
export type NodeSpec = z.infer<typeof NodeSpec>;

/**
 * The run-time `expects` test: did fewer results arrive than the guard needs?
 *
 * A floor, not an equality. A surplus is a stale count for the linter to
 * report, and is never a shortfall. `NodeSpec.expects` says why.
 */
export function expectsShortfall(expects: number, arrivals: number): boolean {
  return arrivals < expects;
}

/**
 * An edge is a real data dependency. It only counts if `carries` names fields
 * that exist in the source's `out` and the target's `in`. An empty `carries`
 * is the fake edge the whole tool exists to find.
 */
export const EdgeSpec = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  carries: z.array(z.string()).default([]),
});
export type EdgeSpec = z.infer<typeof EdgeSpec>;

/**
 * What the members of a boundary may do. `read-only` means no member writes
 * anything: no `writes` entry, and no external effect once effects can be
 * declared. `read-write` is the default and claims nothing.
 */
export const BoundaryAccess = z.enum(["read-only", "read-write"]);
export type BoundaryAccess = z.infer<typeof BoundaryAccess>;

/**
 * A named group of nodes that one constraint covers, so the constraint is said
 * once rather than repeated on every member or left out of the picture. It is
 * drawn as a region around its members and never becomes a node, and it moves
 * no node: ranks and positions are what they would be without it.
 *
 * Today the only constraint is `access`. Limits such as a spend cap or a token
 * budget are expected to attach here later, as further optional fields.
 *
 * Like `uses`, a boundary is a claim. `access` is decidable from the spec for
 * declared `writes`, and that is what the linter can check. Whether a tool a
 * member `uses` is itself read-only is not, because capability ids are opaque.
 *
 * A node belongs to at most one boundary. Nesting and overlap are out of scope:
 * two boundaries that share a member are rejected when the graph is built,
 * rather than given a precedence rule nothing yet needs.
 *
 * The id follows the same rule as a capability id, for the same reason: the
 * banner line that carries a boundary through codegen and back splits on
 * whitespace.
 */
export const BoundarySpec = z.object({
  id: z.string().regex(/^[^\s,]+$/, "no commas or whitespace inside a boundary id"),
  /** A short caption drawn on the region. */
  label: z.string().min(1).optional(),
  members: z.array(z.string().min(1)).min(1),
  access: BoundaryAccess.optional(),
});
export type BoundarySpec = z.infer<typeof BoundarySpec>;

export const WorkflowSpec = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** Rendered as a caption, never as a node. */
  goal: z.string().optional(),
  nodes: z.array(NodeSpec).min(1),
  edges: z.array(EdgeSpec).default([]),
  boundaries: z.array(BoundarySpec).optional(),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

/** How a node should be drawn. Code and human nodes get sharp corners, not sketchy ones. */
export type RenderStyle = "agent" | "code" | "human";

export function renderStyle(node: NodeSpec): RenderStyle {
  if (node.kind === "gate") return "human";
  if (node.model === null) return "code";
  return "agent";
}

/**
 * The agent types a node says it runs as: every `agent:<type>` in `uses`, in the
 * order declared. What draws the "who runs this step" tag, in every format.
 */
export function agentTypes(node: NodeSpec): string[] {
  return (node.uses ?? [])
    .filter((id) => id.startsWith("agent:") && id.length > "agent:".length)
    .map((id) => id.slice("agent:".length));
}

/**
 * The agent tag as it is drawn, `agent: reviewer`, or nothing. One string for
 * every format, so the layout measures exactly what the renderers write.
 */
export function agentTag(node: NodeSpec): string | undefined {
  const types = agentTypes(node);
  return types.length > 0 ? `agent: ${types.join(", ")}` : undefined;
}
