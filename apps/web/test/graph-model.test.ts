// SPDX-License-Identifier: Apache-2.0

/**
 * `buildModel` is used everywhere else in this test suite (bridge.test.ts,
 * capability.test.ts, heat.test.ts, overlay.test.ts) only as a fixture
 * builder — none of them pin what it produces on its own account. This file
 * does: the `ok: false` branch nothing else exercises, and the styling it
 * derives directly from the lint result (fake-edge colouring, per-node
 * problems, fanOut badges) rather than what a later overlay leaves alone.
 */

import { describe, expect, it } from "vitest";
import { buildModel } from "../lib/graph-model";

describe("a spec that fails to parse or validate", () => {
  it("returns ok: false with the failure as a message, not a throw", () => {
    const model = buildModel("not: [valid, yaml", false);
    expect(model.ok).toBe(false);
    if (model.ok) throw new Error("expected a parse failure");
    expect(model.error).toMatch(/not valid YAML/);
  });

  it("reports a schema failure the same way, distinct from a syntax error", () => {
    const model = buildModel(
      `version: 1
name: bad
nodes:
  - id: a
    label: a
    kind: not-a-real-kind
`,
      false,
    );
    expect(model.ok).toBe(false);
    if (model.ok) throw new Error("expected a validation failure");
    expect(model.error).toMatch(/spec failed validation/);
  });
});

/**
 * `a -> b` carries nothing, so the linter calls it fake and separately flags
 * `b` for requiring an input no edge actually supplies — one spec, one finding
 * of each kind this file cares about.
 */
const SPEC = `version: 1
name: model
nodes:
  - id: a
    label: a
    kind: worker
    in: { t: string }
    out: { x: string }
  - id: b
    label: b
    kind: worker
    in: { x: string }
    out: { y: string }
    fanOut: { over: x }
edges:
  - { from: a, to: b, carries: [] }
`;

describe("a clean parse with lint findings", () => {
  it("is ok: true and carries the graph, the lint result and the laid-out nodes/edges", () => {
    const model = buildModel(SPEC, false);
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(model.edges).toHaveLength(1);
  });

  it("marks the fake edge red, dashed, animated and labelled — a real one is none of those", () => {
    const model = buildModel(SPEC, false);
    if (!model.ok) throw new Error(model.error);
    const edge = model.edges[0]!;
    expect(edge.animated).toBe(true);
    expect(edge.label).toBe("carries no data");
    expect(edge.style?.stroke).toBe("#C4442E");
    expect(edge.style?.strokeDasharray).toBe("6 4");
    expect(edge.data?.fake).toBe(true);
  });

  it("stops calling the same edge fake once the caller asks for the repaired graph", () => {
    const model = buildModel(SPEC, true);
    if (!model.ok) throw new Error(model.error);
    for (const edge of model.edges) {
      expect(edge.data?.fake).toBe(false);
      expect(edge.animated).toBe(false);
    }
  });

  it("attributes a non-edge finding to the node it names, and leaves an unflagged node's list empty", () => {
    const model = buildModel(SPEC, false);
    if (!model.ok) throw new Error(model.error);
    const a = model.nodes.find((n) => n.id === "a")!;
    const b = model.nodes.find((n) => n.id === "b")!;
    expect(a.data.problems).toEqual([]);
    expect(b.data.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("MISSING_INPUT")]),
    );
    // The FAKE_EDGE finding names both `a` and `b` too, but it is an edge
    // finding and must not also show up as a per-node problem.
    expect((b.data.problems as string[]).some((p) => p.startsWith("FAKE_EDGE"))).toBe(false);
  });

  it("badges a fanOut node with its cap, and leaves a plain node's badge null", () => {
    const model = buildModel(SPEC, false);
    if (!model.ok) throw new Error(model.error);
    const a = model.nodes.find((n) => n.id === "a")!;
    const b = model.nodes.find((n) => n.id === "b")!;
    expect(a.data.badge).toBeNull();
    // No `cap` was declared on `fanOut`, so the badge falls back to "n".
    expect(b.data.badge).toBe("×n");
  });

  it("defaults a node with no `uses:` to an empty declared-capability list, not undefined", () => {
    const model = buildModel(SPEC, false);
    if (!model.ok) throw new Error(model.error);
    expect(model.nodes.every((n) => Array.isArray(n.data.uses))).toBe(true);
  });
});
