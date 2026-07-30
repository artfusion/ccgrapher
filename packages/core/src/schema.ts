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
  /** A verifier that shares context with the worker it grades is self-grading. */
  freshContext: z.boolean().optional(),
  /** Fan-in count guard. Must equal the effective inbound count — see `effectiveInboundCount`. */
  expects: z.number().int().nonnegative().optional(),
  fanOut: FanOut.optional(),
  /** Isolated worktree per instance, so parallel workers cannot collide on disk. */
  worktree: z.boolean().optional(),
});
export type NodeSpec = z.infer<typeof NodeSpec>;

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

export const WorkflowSpec = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** Rendered as a caption, never as a node. */
  goal: z.string().optional(),
  nodes: z.array(NodeSpec).min(1),
  edges: z.array(EdgeSpec).default([]),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

/** How a node should be drawn. Code and human nodes get sharp corners, not sketchy ones. */
export type RenderStyle = "agent" | "code" | "human";

export function renderStyle(node: NodeSpec): RenderStyle {
  if (node.kind === "gate") return "human";
  if (node.model === null) return "code";
  return "agent";
}
