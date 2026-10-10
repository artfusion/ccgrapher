// SPDX-License-Identifier: Apache-2.0
import {
  buildGraph,
  formatSpec,
  NodeSpec,
  WorkflowSpec,
  type Graph,
  type NodeSpec as NodeSpecType,
} from "@ccgrapher/core";
import { applyRepairs, proposeRepairs, type Finding, type IndexedRepair } from "@ccgrapher/lint";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * The node inspector's logic, kept out of React so it can be tested in plain
 * Node: which control each field of a node gets, what an edit does to the
 * spec, and which lint findings (and repairs) belong to a node.
 *
 * ## Schema-driven, on purpose
 *
 * The controls are not written per field. `NODE_FIELDS` is read off the zod
 * schema itself (`NodeSpec.shape` in `@ccgrapher/core`), one entry per key in
 * the order the schema declares them, and each entry's control follows from
 * the field's zod type:
 *
 *   enum                    -> a select (plus "unset" when optional, and
 *                              "null" when nullable: `model: null` is plain code)
 *   boolean                 -> a toggle
 *   number                  -> a number input
 *   string                  -> a text input
 *   string[]                -> editable chips (`uses`, `writes`)
 *   record<string, string>  -> key/type rows (`in`, `out`)
 *   object of the above     -> a small group of those controls (`fanOut`)
 *   anything else           -> the field's raw YAML, edited as text
 *
 * So a field added to the schema appears in the panel with no UI work. The
 * last line is the safety net: a shape the table does not know (a list of
 * objects, a union) still gets edited, as YAML, and still goes through the
 * same validation. What the table cannot know is prose; `HINTS` adds a line of
 * help to some fields, and a field without one simply shows its key.
 *
 * ## What an edit is
 *
 * Every edit is checked against the same zod schema the parser uses, first for
 * the node and then for the whole spec, and then against `buildGraph`. Only a
 * spec that passes all three is formatted (`formatSpec`, the path every other
 * structural edit takes) and handed back. A value that fails is returned as
 * the reason it failed, and the spec is left exactly as it was: never applied,
 * never silently dropped.
 */

/** The parts of a zod v4 schema this file reads. Structural, so `zod` need not be imported here. */
export interface SchemaLike {
  readonly def: {
    readonly type: string;
    readonly innerType?: SchemaLike;
    readonly element?: SchemaLike;
    readonly keyType?: SchemaLike;
    readonly valueType?: SchemaLike;
    readonly entries?: Readonly<Record<string, string | number>>;
    readonly shape?: Readonly<Record<string, SchemaLike>>;
  };
  readonly isInt?: boolean;
}

export type Control =
  | { readonly type: "text" }
  | { readonly type: "select"; readonly options: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "number"; readonly integer: boolean }
  | { readonly type: "chips" }
  | { readonly type: "record" }
  | { readonly type: "group"; readonly fields: readonly Field[] }
  | { readonly type: "yaml" };

export interface Field {
  readonly key: string;
  readonly control: Control;
  /** Absent is a legal value, so the control offers a way back to it. */
  readonly optional: boolean;
  /** `null` is a legal value with its own meaning. */
  readonly nullable: boolean;
  readonly readOnly: boolean;
  readonly hint?: string;
}

/**
 * Renaming a step is not a field edit: every edge and boundary naming it would
 * have to follow. Shown, not editable here; the text is where a rename happens.
 */
const READ_ONLY = new Set(["id"]);

/** Help text, optional per field. A field missing from this table is still shown and editable. */
const HINTS: Readonly<Record<string, string>> = {
  id: "renaming a step moves its edges too, so it happens in the text",
  model: "unset is an agent of no stated tier; null is plain code, no model",
  in: "the fields this step reads",
  out: "the fields this step produces",
  writes: "files or APIs it touches; two concurrent steps sharing one is a hidden edge",
  uses: "capabilities it needs: agent:<type>, skill:<name>, mcp:<server>/<tool>",
  effects: "what it does that cannot be taken back, as <verb>:<target>",
  guards: "effects it makes at most once, checking first whether they already happened",
  freshContext: "a verifier that shares the worker's context is grading itself",
  expects: "how many results must arrive before it runs",
  fanOut: "run once per item in `over`, up to `cap` at a time",
  worktree: "an isolated checkout per instance, so parallel copies cannot collide",
  priority: "which ready step gets the next free slot; what it waits on goes first with it",
  prioritySetBy: "who asked for it, a role or a rota, shown wherever the priority is",
};

/** Sentinels a select uses for the two values that are not strings. */
export const UNSET = "\u0000unset";
export const NULL = "\u0000null";

export function fieldsOf(shape: Readonly<Record<string, SchemaLike>>): Field[] {
  return Object.entries(shape).map(([key, schema]) => fieldOf(key, schema));
}

function fieldOf(key: string, schema: SchemaLike): Field {
  let optional = false;
  let nullable = false;
  let inner = schema;
  // Peel the wrappers. `default` adds nothing to the control: the parser fills
  // it in, so by the time the panel sees a node the value is always there.
  for (;;) {
    const { type, innerType } = inner.def;
    if (innerType === undefined) break;
    if (type === "optional") optional = true;
    else if (type === "nullable") nullable = true;
    else if (type !== "default") break;
    inner = innerType;
  }
  return {
    key,
    control: controlFor(inner),
    optional,
    nullable,
    readOnly: READ_ONLY.has(key),
    hint: HINTS[key],
  };
}

const SCALAR = new Set(["text", "select", "toggle", "number"]);

function controlFor(schema: SchemaLike): Control {
  const { def } = schema;
  switch (def.type) {
    case "string":
      return { type: "text" };
    case "enum":
      return { type: "select", options: Object.values(def.entries ?? {}).map(String) };
    case "boolean":
      return { type: "toggle" };
    case "number":
      return { type: "number", integer: schema.isInt === true };
    case "array":
      return def.element?.def.type === "string" ? { type: "chips" } : { type: "yaml" };
    case "record":
      return def.keyType?.def.type === "string" && def.valueType?.def.type === "string"
        ? { type: "record" }
        : { type: "yaml" };
    case "object": {
      const fields = fieldsOf(def.shape ?? {});
      return fields.every((f) => SCALAR.has(f.control.type))
        ? { type: "group", fields }
        : { type: "yaml" };
    }
    default:
      return { type: "yaml" };
  }
}

/** Every field of a node, in schema order, each with the control it gets. */
export const NODE_FIELDS: readonly Field[] = fieldsOf(
  NodeSpec.shape as unknown as Record<string, SchemaLike>,
);

export type Edit =
  | { readonly ok: true; readonly spec: WorkflowSpec; readonly source: string }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Set one top-level field of one node, or remove it with `undefined`.
 *
 * A group (`fanOut`) is set whole: the panel composes the object and passes
 * it here, so an incomplete one (a `cap` with no `over`) reaches the schema
 * and is refused with the schema's reason.
 */
export function editNode(spec: WorkflowSpec, nodeId: string, key: string, value: unknown): Edit {
  const node = spec.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, errors: [`no step '${nodeId}' in this spec`] };

  const candidate: Record<string, unknown> = { ...node };
  if (value === undefined) delete candidate[key];
  else candidate[key] = value;

  const parsed = NodeSpec.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const below = issue.path.slice(1).join(".");
        const reason = describeIssue(issue);
        return below === "" ? reason : `${below}: ${reason}`;
      }),
    };
  }

  return finish({
    ...spec,
    nodes: spec.nodes.map((n) => (n.id === nodeId ? parsed.data : n)),
  });
}

/** The parts of a zod issue `describeIssue` reads. */
export interface IssueLike {
  readonly code: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly origin?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly inclusive?: boolean;
  readonly values?: readonly unknown[];
}

/**
 * A zod issue in words, built from the issue's own fields.
 *
 * Not `issue.message` alone: in the production bundle zod's English messages
 * can be shaken out as an unused side effect, and every built-in message then
 * collapses to "Invalid input", which is a refusal without its reason. A
 * message a schema wrote itself (the capability-id regex) is always kept.
 */
export function describeIssue(issue: IssueLike): string {
  const expected = issue.expected === "int" ? "a whole number" : String(issue.expected);
  const bound = (word: string, limit: unknown, inclusive: boolean | undefined) =>
    `${word}${inclusive === false ? " than" : ""} ${String(limit)}`;
  switch (issue.code) {
    case "invalid_type":
      return `expected ${expected}`;
    case "too_small":
      if (issue.origin === "string" && issue.minimum === 1) return "cannot be empty";
      return issue.origin === "number"
        ? `must be ${bound(issue.inclusive === false ? "more" : "at least", issue.minimum, issue.inclusive)}`
        : `needs at least ${String(issue.minimum)} ${issue.origin === "string" ? "characters" : "entries"}`;
    case "too_big":
      return issue.origin === "number"
        ? `must be ${bound(issue.inclusive === false ? "less" : "at most", issue.maximum, issue.inclusive)}`
        : `takes at most ${String(issue.maximum)} ${issue.origin === "string" ? "characters" : "entries"}`;
    case "invalid_value":
      return `expected one of ${(issue.values ?? []).map(String).join(", ")}`;
    default:
      return issue.message;
  }
}

/** Validate a whole spec the way the parser and the graph builder would, then format it. */
function finish(next: WorkflowSpec): Edit {
  const whole = WorkflowSpec.safeParse(next);
  if (!whole.success) {
    return {
      ok: false,
      errors: whole.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${describeIssue(i)}`),
    };
  }
  try {
    buildGraph(whole.data);
  } catch (cause) {
    return { ok: false, errors: [cause instanceof Error ? cause.message : String(cause)] };
  }
  return { ok: true, spec: whole.data, source: formatSpec(whole.data) };
}

/** A field's value as the YAML fallback shows it. */
export function toYaml(value: unknown): string {
  return value === undefined ? "" : stringifyYaml(value, { flowCollectionPadding: true }).trimEnd();
}

/** The YAML fallback's text back to a value: empty is "remove the field". */
export function fromYaml(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: parseYaml(text) as unknown };
  } catch (cause) {
    return { ok: false, error: `not valid YAML: ${(cause as Error).message}` };
  }
}

/**
 * The text a number input holds, as the value to validate. Empty is "remove";
 * anything else that is not a number goes through as the string it is, so the
 * schema refuses it with its own reason rather than this file inventing one.
 */
export function fromNumberText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isNaN(n) ? trimmed : n;
}

export interface NodeFinding {
  readonly finding: Finding;
  /** Present only when the linter itself offers a repair for this finding today. */
  readonly repair?: IndexedRepair;
}

/**
 * The findings that name this node, each with the repair the linter proposes
 * for it, if any. Only a FAKE_EDGE found in the graph as written has one (an
 * edge repointed or dropped); every other rule is detect-only, and a finding
 * that only appears after repair has nothing to apply yet.
 */
export function findingsFor(
  base: Graph,
  findings: readonly Finding[],
  nodeId: string,
): NodeFinding[] {
  const repairs = proposeRepairs(base);
  return findings
    .filter((f) => f.nodes.includes(nodeId))
    .map((finding) => {
      const edge = finding.edge;
      if (finding.rule !== "FAKE_EDGE" || finding.phase !== "raw" || !edge) return { finding };
      const repair = repairs.find((r) => r.repair.from === edge.from && r.repair.to === edge.to);
      return repair ? { finding, repair } : { finding };
    });
}

/** One repair, applied on its own, to the spec as written. */
export function applyRepair(base: Graph, repair: IndexedRepair): Edit {
  return finish({ ...base.spec, edges: applyRepairs(base, [repair]) });
}

export function describeRepair({ repair }: IndexedRepair): string {
  if (repair.kind === "drop") return `drop ${repair.from} → ${repair.to}`;
  const carrying = `carrying ${repair.carries.join(", ")}`;
  return repair.newFrom === repair.from
    ? `keep ${repair.from} → ${repair.to}, ${carrying}`
    : `wire ${repair.newFrom} → ${repair.to} ${carrying}, in place of ${repair.from} → ${repair.to}`;
}

/** A node's current value for a field, read for display. */
export function valueOf(node: NodeSpecType, key: string): unknown {
  return (node as unknown as Record<string, unknown>)[key];
}
