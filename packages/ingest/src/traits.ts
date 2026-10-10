// SPDX-License-Identifier: Apache-2.0
import type { NodeKind, NodeSpec } from "@ccgrapher/core";

const KINDS: readonly NodeKind[] = [
  "goal",
  "split",
  "worker",
  "verifier",
  "reduce",
  "synthesize",
  "gate",
];

export type NodeTraits = Pick<
  NodeSpec,
  | "label"
  | "kind"
  | "model"
  | "freshContext"
  | "worktree"
  | "expects"
  | "writes"
  | "uses"
  | "effects"
  | "guards"
  | "fanOut"
  | "priority"
  | "prioritySetBy"
>;

/**
 * Reads the documentation comment codegen writes above each node function:
 *
 *   /** audit one route file — worker, model: cheap, isolated worktree,
 *       expects 20. Runs once per file, capped at 20. *\/
 *
 * Everything TypeScript's own syntax cannot express lives there, so this is
 * where kind, model tier, isolation and the fan-in guard come back from.
 */
export function parseTraits(doc: string, fallbackLabel: string): NodeTraits {
  const text = doc.replace(/\s+/g, " ").trim();

  const traits: NodeTraits = {
    label: fallbackLabel,
    kind: "worker",
  };

  const [, label, rest] = /^(.*?)\s+—\s+(.*)$/.exec(text) ?? [];
  if (label) traits.label = label.trim();

  let body = rest ?? text;

  // Who set the priority is free text, so codegen quotes it as JSON in a
  // sentence of its own. Taken out first, so nothing in it reads as a trait.
  const setBy = /\s*Priority set by ("(?:[^"\\]|\\.)*")\./.exec(body);
  if (setBy) {
    try {
      const value: unknown = JSON.parse(setBy[1]!);
      if (typeof value === "string") traits.prioritySetBy = value;
    } catch {
      // Not ours after all: leave the sentence where it was.
    }
    if (traits.prioritySetBy !== undefined) body = body.replace(setBy[0], "");
  }
  // Everything before the sentence that describes the fan-out.
  const [, list] = /^(.*?)\.(?:\s|$)/.exec(body) ?? [, body];

  for (const raw of (list ?? "").split(",")) {
    const trait = raw.trim();
    if (!trait) continue;

    if ((KINDS as readonly string[]).includes(trait)) {
      traits.kind = trait as NodeKind;
    } else if (trait === "plain code") {
      traits.model = null;
    } else if (trait === "fresh context") {
      traits.freshContext = true;
    } else if (trait === "isolated worktree") {
      traits.worktree = true;
    } else if (trait.startsWith("model: ")) {
      const tier = trait.slice(7).trim();
      if (tier === "cheap" || tier === "strong") traits.model = tier;
    } else if (trait.startsWith("expects ")) {
      const n = Number(trait.slice(8).trim());
      if (Number.isInteger(n)) traits.expects = n;
    } else if (trait.startsWith("writes ")) {
      traits.writes = trait.slice(7).trim().split(/\s+/).filter(Boolean);
    } else if (trait.startsWith("uses ")) {
      traits.uses = trait.slice(5).trim().split(/\s+/).filter(Boolean);
    } else if (trait.startsWith("effects ")) {
      traits.effects = trait.slice(8).trim().split(/\s+/).filter(Boolean);
    } else if (trait.startsWith("guards ")) {
      traits.guards = trait.slice(7).trim().split(/\s+/).filter(Boolean);
    } else if (trait.startsWith("priority: ")) {
      const level = trait.slice(10).trim();
      if (level === "urgent" || level === "high" || level === "normal") traits.priority = level;
    }
  }

  const fan = /Runs once per (\w+)(?:, capped at (\d+))?/.exec(body);
  if (fan) {
    traits.fanOut = fan[2]
      ? { over: fan[1]!, cap: Number(fan[2]) }
      : { over: fan[1]! };
  }

  return traits;
}
