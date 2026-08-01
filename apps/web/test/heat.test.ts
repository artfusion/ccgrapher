// SPDX-License-Identifier: Apache-2.0
import { HeatData } from "@ccgrapher/trace";
import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { applyHeat, formatHeat, HEAT_RAMP, HEAT_UNMEASURED_FILL } from "../lib/heat";
import { buildModel } from "../lib/graph-model";
import { FIXTURES } from "../lib/fixtures";

/**
 * Verbatim output of
 *
 *   ccg trace stats examples/traces/live-demo.jsonl --heat … --metric duration-ms
 *
 * over the trace in this repo, against the `live-demo` fixture. Kept as it came
 * out rather than tidied, because the case worth testing is the one the producer
 * actually produces: seven nodes in the spec, five with a duration. `review` sat
 * at a gate and `count_lines` never ran, so neither is in `values` — and neither
 * of them is fast.
 */
const DURATION = {
  v: 1,
  metric: "duration-ms",
  unit: "ms",
  source: "ccg trace stats examples/traces/live-demo.jsonl",
  values: { plan: 21, fetch_code: 16, fetch_docs: 42, summarise: 37, publish: 13 },
} as const;

/** Same trace, `--metric cost-usd`. Sparser still: three of seven priced. */
const COST = {
  v: 1,
  metric: "cost-usd",
  unit: "usd",
  source: "ccg trace stats examples/traces/live-demo.jsonl",
  values: { plan: 0.0004, fetch_docs: 0.0018, summarise: 0.0091 },
} as const;

function liveDemo(): Node[] {
  const model = buildModel(FIXTURES["live-demo"]!, false);
  if (!model.ok) throw new Error(model.error);
  return model.nodes;
}

function heatOf(node: Node): { value?: number; text: string; band?: number } | undefined {
  return (node.data as { heat?: { value?: number; text: string; band?: number } }).heat;
}

function byId(nodes: Node[], id: string): Node {
  const found = nodes.find((node) => node.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe("the files the CLI actually writes", () => {
  it("both parse as the published contract", () => {
    expect(HeatData.parse(DURATION).values["fetch_docs"]).toBe(42);
    expect(HeatData.parse(COST).unit).toBe("usd");
  });
});

describe("normalisation", () => {
  it("anchors the scale at zero, not at the smallest value present", () => {
    const { legend } = applyHeat(liveDemo(), HeatData.parse(DURATION));
    // Five bands over 0…42, so 8.4 ms each. Anchored at 13 instead, the fastest
    // node measured would sit at the very bottom of the ramp and a 3× spread
    // would be drawn as a total one.
    const starts = legend!.bands.map((b) => b.from);
    expect(starts).toHaveLength(5);
    starts.forEach((from, i) => expect(from).toBeCloseTo(i * 8.4, 10));
    expect(legend!.bands.at(-1)!.to).toBeCloseTo(42, 10);
    expect(legend!.bands.map((b) => b.fill)).toEqual([...HEAT_RAMP]);
  });

  it("puts each measured node in the band its value falls in", () => {
    const { nodes } = applyHeat(liveDemo(), HeatData.parse(DURATION));
    expect(heatOf(byId(nodes, "publish"))!.band).toBe(1); // 13 ms
    expect(heatOf(byId(nodes, "fetch_code"))!.band).toBe(1); // 16 ms
    expect(heatOf(byId(nodes, "plan"))!.band).toBe(2); // 21 ms
    expect(heatOf(byId(nodes, "summarise"))!.band).toBe(4); // 37 ms
    // The maximum belongs to the top band, not to a sixth one off the end.
    expect(heatOf(byId(nodes, "fetch_docs"))!.band).toBe(HEAT_RAMP.length - 1);
  });

  it("says so when every measured node reads the same", () => {
    const flat = HeatData.parse({ ...DURATION, values: { plan: 9, publish: 9 } });
    const { nodes, legend } = applyHeat(liveDemo(), flat);

    // Anchored at zero, "all equal to the maximum" really is the top band, and
    // the legend really does run 0…9, so the ramp is drawn and is correct. What
    // it is not is a finding, so `flat` is there for the legend to say so.
    expect(legend!.flat).toBe(true);
    expect(legend!.bands).toHaveLength(5);
    expect(heatOf(byId(nodes, "plan"))!.band).toBe(4);
    expect(heatOf(byId(nodes, "publish"))!.band).toBe(4);
  });

  it("puts a measured zero at the cold end rather than inventing a middle", () => {
    // A cost of nothing is a measurement, unlike a cost nobody recorded. There
    // is no domain to draw a ramp over, but the node is still measured.
    const zeroes = HeatData.parse({ ...COST, values: { plan: 0, summarise: 0 } });
    const { nodes, legend } = applyHeat(liveDemo(), zeroes);
    expect(legend!.bands).toEqual([]);
    expect(legend!.measured).toBe(2);
    expect(heatOf(byId(nodes, "plan"))).toEqual({ value: 0, text: "$0", band: 0 });
    expect(heatOf(byId(nodes, "review"))).toEqual({ text: "no data" });
  });

  it("says so rather than dividing by zero when nothing on screen is measured", () => {
    const foreign = HeatData.parse({ ...DURATION, values: { nobody: 5, nothing: 8 } });
    const { nodes, legend } = applyHeat(liveDemo(), foreign);
    expect(legend!.measured).toBe(0);
    expect(legend!.bands).toEqual([]);
    // And it counts the entries that matched nothing, so a heat file loaded over
    // the wrong spec announces itself instead of drawing a graph of "no data".
    expect(legend!.unmatched).toBe(2);
    for (const node of nodes) expect(heatOf(node)!.value).toBeUndefined();
  });

  it("formats in the file's own unit and never converts", () => {
    expect(formatHeat(42, "ms")).toBe("42 ms");
    expect(formatHeat(90000, "ms")).toBe("90000 ms");
    expect(formatHeat(0.0091, "usd")).toBe("$0.0091");
    expect(formatHeat(0.07722222222222222, "hours")).toBe("0.077 hours");
  });
});

describe("the sparse map", () => {
  it("draws a node with no entry as unmeasured, not as the cold end", () => {
    const { nodes, legend } = applyHeat(liveDemo(), HeatData.parse(DURATION));

    const unmeasured = byId(nodes, "count_lines");
    expect(heatOf(unmeasured)).toEqual({ text: "no data" });
    expect(unmeasured.className).toContain("heat-unmeasured");
    expect(unmeasured.className).not.toContain("heat-measured");

    // The fill is off the ramp entirely — not `HEAT_RAMP[0]`, which is what
    // "this was fast" would look like.
    const fill = (unmeasured.style as Record<string, string>)["--heat-fill"];
    expect(fill).toBe(HEAT_UNMEASURED_FILL);
    expect(HEAT_RAMP).not.toContain(fill);

    // And the caption says which it is, in words.
    expect((unmeasured.style as Record<string, string>)["--heat-label"]).toBe('"no data"');

    expect(legend!.measured).toBe(5);
    expect(legend!.unmeasured).toBe(2);
  });

  it("keeps the gate unmeasured under the cost file too", () => {
    // `review` is a human gate: it never had a duration and never had a price.
    // Under cost-usd four more nodes join it, and none of them becomes a zero.
    const { nodes, legend } = applyHeat(liveDemo(), HeatData.parse(COST));
    expect(legend!.measured).toBe(3);
    expect(heatOf(byId(nodes, "review"))).toEqual({ text: "no data" });
    expect(heatOf(byId(nodes, "count_lines"))).toEqual({ text: "no data" });
    expect(heatOf(byId(nodes, "fetch_code"))).toEqual({ text: "no data" });
    expect(heatOf(byId(nodes, "summarise"))!.text).toBe("$0.0091");
  });

  it("never turns an absent measurement into a zero", () => {
    const { nodes } = applyHeat(liveDemo(), HeatData.parse(DURATION));
    for (const node of nodes) {
      const heat = heatOf(node)!;
      if (heat.value === undefined) expect(heat.text).toBe("no data");
      else expect(heat.value).toBeGreaterThan(0);
    }
    // A zero would have been an entry in `values`, not a missing one.
    expect(nodes.filter((n) => heatOf(n)!.value === undefined)).toHaveLength(2);
  });

  it("leaves the lint data that was already on the node alone", () => {
    const before = liveDemo();
    const { nodes } = applyHeat(before, HeatData.parse(DURATION));
    expect(nodes[0]!.data.lines).toBe(before[0]!.data.lines);
    expect(nodes[0]!.data.problems).toBe(before[0]!.data.problems);
  });

  it("returns the same array when there is no heat file", () => {
    const before = liveDemo();
    const after = applyHeat(before, undefined);
    expect(after.nodes).toBe(before);
    expect(after.legend).toBeUndefined();
  });
});
