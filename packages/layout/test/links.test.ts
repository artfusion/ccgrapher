// SPDX-License-Identifier: Apache-2.0
import { buildGraph, parseSpec } from "@ccgrapher/core";
import { describe, expect, it } from "vitest";
import { layoutGraph, routeLinks, type Point, type PositionedNode } from "../src/index.js";

const SPEC = `
version: 1
name: links
nodes:
  - { id: top, label: start, kind: split, in: { q: string }, out: { a: string } }
  - { id: lone, label: stamp the version, kind: worker, in: { q: string }, out: { v: string } }
  - { id: tag, label: tag it, kind: worker, in: { v: string }, out: { t: string } }
  - { id: w1, label: first, kind: worker, in: { a: string }, out: { x: string } }
  - { id: mid, label: middle, kind: worker, in: { a: string }, out: { y: string } }
  - { id: w3, label: third, kind: worker, in: { a: string }, out: { z: string } }
edges:
  - { from: top, to: w1, carries: [a] }
  - { from: top, to: mid, carries: [a] }
  - { from: top, to: w3, carries: [a] }
  - { from: lone, to: tag, carries: [v] }
`;

const positioned = layoutGraph(buildGraph(parseSpec(SPEC)));
const at = (id: string) => positioned.nodes.find((n) => n.id === id)!;

/** Does the segment pass through the inside of the box? Sampled finely, which is plenty for axis-aligned runs. */
function crosses(p: Point, q: Point, n: PositionedNode): boolean {
  for (let t = 0; t <= 1; t += 0.01) {
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    if (x > n.x + 1 && x < n.x + n.width - 1 && y > n.y + 1 && y < n.y + n.height - 1) return true;
  }
  return false;
}

const clear = (points: readonly Point[], ends: readonly string[]) =>
  positioned.nodes
    .filter((n) => !ends.includes(n.id))
    .filter((n) => points.some((p, k) => k > 0 && crosses(points[k - 1]!, p, n)))
    .map((n) => n.id);

describe("routeLinks", () => {
  it("brackets two nodes on one row over the lane above it, past the node between", () => {
    const [route] = routeLinks(positioned, [["w3", "w1"]]);
    expect(route!.points).toHaveLength(4);
    const lane = route!.points[1]!.y;
    expect(lane).toBeLessThan(Math.min(at("w1").y, at("w3").y) - 10);
    // Above the row and below the row before it.
    expect(lane).toBeGreaterThan(at("top").y + at("top").height);
    expect(route!.points[0]!.y).toBe(at("w1").y);
    expect(clear(route!.points, ["w1", "w3"])).toEqual([]);
    expect(route!.label.y).toBe(lane);
  });

  it("goes round by the margin between rows, through no box", () => {
    expect(at("lone").y).not.toBe(at("w1").y);
    const [route] = routeLinks(positioned, [["lone", "w1"]]);
    expect(route!.points).toHaveLength(6);
    const side = route!.points[2]!.x;
    const outside =
      side > Math.max(...positioned.nodes.map((n) => n.x + n.width)) ||
      side < Math.min(...positioned.nodes.map((n) => n.x));
    expect(outside).toBe(true);
    expect(side).toBeGreaterThan(0);
    expect(side).toBeLessThan(positioned.width);
    expect(clear(route!.points, ["lone", "w1"])).toEqual([]);
  });

  it("raises each further link over a row by a lane", () => {
    const [a, b] = routeLinks(positioned, [
      ["w1", "w3"],
      ["w1", "mid"],
    ]);
    expect(b!.points[1]!.y).toBeLessThan(a!.points[1]!.y);
  });

  it("skips a pair naming a node that is not there, and is deterministic", () => {
    expect(routeLinks(positioned, [["w1", "nowhere"]])).toEqual([]);
    expect(routeLinks(positioned, [["w1", "w3"]])).toEqual(routeLinks(positioned, [["w1", "w3"]]));
  });
});
