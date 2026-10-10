// SPDX-License-Identifier: Apache-2.0
import { buildGraph, NodeSpec, parseSpec } from "@ccgrapher/core";
import { lint } from "@ccgrapher/lint";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../lib/fixtures";
import {
  applyRepair,
  describeIssue,
  editNode,
  fieldsOf,
  findingsFor,
  fromNumberText,
  fromYaml,
  NODE_FIELDS,
  toYaml,
  type SchemaLike,
} from "../lib/inspector";

const chain = () => parseSpec(FIXTURES["linear-chain"]!);
const field = (key: string) => NODE_FIELDS.find((f) => f.key === key)!;

describe("the field table, read off the schema", () => {
  it("covers every field of a node, in schema order, with nothing written per field", () => {
    // Not a pinned list: a field the schema gains must appear here on its own.
    expect(NODE_FIELDS.map((f) => f.key)).toEqual(Object.keys(NodeSpec.shape));
    for (const key of ["label", "kind", "model", "in", "out", "writes", "uses", "expects"]) {
      expect(NODE_FIELDS.some((f) => f.key === key)).toBe(true);
    }
    // The cross-run fields arrived after the panel was written, and still get chips.
    expect(field("effects")?.control.type).toBe("chips");
    expect(field("guards")?.control.type).toBe("chips");
  });

  it("gives each zod type its control", () => {
    expect(field("kind").control).toEqual({
      type: "select",
      options: ["goal", "split", "worker", "verifier", "reduce", "synthesize", "gate"],
    });
    // The tier: unset and null are both legal, and they mean different things.
    expect(field("model")).toMatchObject({
      control: { type: "select", options: ["cheap", "strong"] },
      optional: true,
      nullable: true,
    });
    expect(field("freshContext").control.type).toBe("toggle");
    expect(field("expects").control).toEqual({ type: "number", integer: true });
    expect(field("uses").control.type).toBe("chips");
    expect(field("writes").control.type).toBe("chips");
    expect(field("in").control.type).toBe("record");
    expect(field("in").optional).toBe(false);
    expect(field("id").readOnly).toBe(true);
    // Urgency arrived after the panel too: a select with a way back to unset, and a line of text.
    expect(field("priority")).toMatchObject({
      control: { type: "select", options: ["urgent", "high", "normal"] },
      optional: true,
      nullable: false,
    });
    expect(field("prioritySetBy")).toMatchObject({ control: { type: "text" }, optional: true });

    const fanOut = field("fanOut").control;
    expect(fanOut.type).toBe("group");
    if (fanOut.type !== "group") return;
    expect(fanOut.fields.map((f) => [f.key, f.control.type, f.optional])).toEqual([
      ["over", "text", false],
      ["cap", "number", true],
    ]);
  });

  it("falls back to raw YAML for a shape it has no control for", () => {
    const string: SchemaLike = { def: { type: "string" } };
    const fields = fieldsOf({
      effects: {
        def: {
          type: "optional",
          innerType: { def: { type: "array", element: { def: { type: "object", shape: {} } } } },
        },
      },
      schedule: { def: { type: "union" } },
      nested: {
        def: {
          type: "object",
          shape: { deep: { def: { type: "record", keyType: string, valueType: string } } },
        },
      },
    });
    expect(fields.map((f) => [f.key, f.control.type])).toEqual([
      ["effects", "yaml"],
      ["schedule", "yaml"],
      ["nested", "yaml"],
    ]);
  });
});

describe("an edit from the panel", () => {
  it("rewrites the spec, and the text, the model and the lint agree", () => {
    const edit = editNode(chain(), "write_report", "model", "cheap");
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.source).toMatch(/model: cheap/);
    const reparsed = parseSpec(edit.source);
    expect(reparsed.nodes.find((n) => n.id === "write_report")!.model).toBe("cheap");
  });

  it("writes null for plain code and removes the key for unset", () => {
    const toCode = editNode(chain(), "write_report", "model", null);
    expect(toCode.ok && parseSpec(toCode.source).nodes.at(-1)!.model).toBeNull();
    const unset = editNode(chain(), "write_report", "model", undefined);
    expect(unset.ok && "model" in parseSpec(unset.source).nodes.at(-1)!).toBe(false);
  });

  it("marks a step urgent and says who asked, and the lint does not move", () => {
    const urgent = editNode(chain(), "write_report", "priority", "urgent");
    expect(urgent.ok).toBe(true);
    if (!urgent.ok) return;
    const who = editNode(urgent.spec, "write_report", "prioritySetBy", "on-call");
    expect(who.ok).toBe(true);
    if (!who.ok) return;
    expect(parseSpec(who.source).nodes.at(-1)).toMatchObject({ priority: "urgent", prioritySetBy: "on-call" });
    expect(lint(buildGraph(who.spec)).findings).toEqual(lint(buildGraph(chain())).findings);
    expect(editNode(chain(), "write_report", "priority", "asap").ok).toBe(false);
  });

  it("changes what the linter says when expects stops matching the graph", () => {
    expect(lint(buildGraph(chain())).findings.some((f) => f.rule === "SILENT_FAILURE")).toBe(false);
    const edit = editNode(chain(), "collate", "expects", 2);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const findings = lint(buildGraph(parseSpec(edit.source))).findings;
    expect(findings.find((f) => f.rule === "SILENT_FAILURE")?.nodes).toEqual(["collate"]);
  });

  it("refuses an invalid value with the schema's reason, and changes nothing", () => {
    const spec = chain();
    for (const [key, value] of [
      ["expects", -1],
      ["expects", 2.5],
      ["expects", "three"],
      ["uses", ["agent:has space"]],
      ["kind", "wizard"],
      ["label", ""],
      ["fanOut", { cap: 3 }],
    ] as const) {
      const edit = editNode(spec, "collate", key, value);
      expect(edit.ok, `${key} = ${JSON.stringify(value)}`).toBe(false);
      if (edit.ok) continue;
      expect(edit.errors.length).toBeGreaterThan(0);
    }
    const spaced = editNode(spec, "collate", "uses", ["agent:has space"]);
    expect(!spaced.ok && spaced.errors.join()).toMatch(/no commas or whitespace/);
    const capOnly = editNode(spec, "collate", "fanOut", { cap: 3 });
    expect(!capOnly.ok && capOnly.errors).toEqual(["over: expected string"]);
    const fraction = editNode(spec, "collate", "expects", 2.5);
    expect(!fraction.ok && fraction.errors).toEqual(["expected a whole number"]);
    const kind = editNode(spec, "collate", "kind", "wizard");
    expect(!kind.ok && kind.errors.join()).toMatch(/^expected one of goal, split, worker/);
    const empty = editNode(spec, "collate", "label", "");
    expect(!empty.ok && empty.errors).toEqual(["cannot be empty"]);
    // The spec object passed in is untouched.
    expect(spec).toEqual(chain());
  });

  it("refuses a step it cannot find", () => {
    expect(editNode(chain(), "nope", "label", "x")).toMatchObject({ ok: false });
  });
});

describe("findings on a node, and their repairs", () => {
  it("offers the linter's repair for a fake edge, and applies just that one", () => {
    const base = buildGraph(chain());
    const result = lint(base);
    const onB = findingsFor(base, result.findings, "review_b");
    const fake = onB.filter((f) => f.finding.rule === "FAKE_EDGE");
    expect(fake.length).toBe(2);
    expect(fake.every((f) => f.repair !== undefined)).toBe(true);

    const first = fake.find((f) => f.finding.edge!.from === "review_a")!;
    const applied = applyRepair(base, first.repair!);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const after = lint(buildGraph(parseSpec(applied.source)));
    const remaining = after.findings.filter((f) => f.rule === "FAKE_EDGE");
    // One fake edge repaired, the other still there to be repaired.
    expect(remaining.map((f) => `${f.edge!.from}->${f.edge!.to}`)).toEqual(["review_b->lint_docs"]);
  });

  it("gives a detect-only finding no repair", () => {
    const base = buildGraph(chain());
    const onCollate = findingsFor(base, lint(base).findings, "review_a");
    const hidden = onCollate.filter((f) => f.finding.rule !== "FAKE_EDGE");
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((f) => f.repair === undefined)).toBe(true);
  });
});

describe("a refusal's reason", () => {
  it("is built from the issue's fields, so it survives a bundle without zod's messages", () => {
    const bare = { message: "Invalid input" };
    expect(describeIssue({ ...bare, code: "invalid_type", expected: "int" })).toBe(
      "expected a whole number",
    );
    expect(
      describeIssue({ ...bare, code: "too_small", origin: "number", minimum: 0, inclusive: false }),
    ).toBe("must be more than 0");
    expect(describeIssue({ ...bare, code: "too_big", origin: "array", maximum: 2 })).toBe(
      "takes at most 2 entries",
    );
    // A message the schema wrote itself is kept as written.
    expect(describeIssue({ code: "invalid_format", message: "no commas" })).toBe("no commas");
  });
});

describe("value parsing for text controls", () => {
  it("reads a number input, keeping what is not a number for the schema to refuse", () => {
    expect(fromNumberText("")).toBeUndefined();
    expect(fromNumberText(" 3 ")).toBe(3);
    expect(fromNumberText("three")).toBe("three");
  });

  it("round-trips the YAML fallback, and says when it does not parse", () => {
    expect(fromYaml(toYaml({ over: "items", cap: 3 }))).toEqual({
      ok: true,
      value: { over: "items", cap: 3 },
    });
    expect(fromYaml("")).toEqual({ ok: true, value: undefined });
    expect(fromYaml("a: [b")).toMatchObject({ ok: false });
  });
});
