// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { specToGraph, type Cell, type ElementCell, type LinkCell } from "../app/canvas/bridge";
import {
  diffCells,
  ease,
  frameAt,
  Motion,
  MOTION_MS,
  motionDuration,
  planTracks,
  syncLayout,
  type Box,
  type Clock,
  type Frame,
  type LayoutTarget,
  type LiveLink,
} from "../app/canvas/motion";
import { FIXTURES } from "../lib/fixtures";
import { buildModel } from "../lib/graph-model";

const el = (id: string, x = 0, y = 0, width = 100, height = 40): ElementCell => ({
  id,
  type: "element",
  position: { x, y },
  size: { width, height },
  data: {},
});

const link = (from: string, to: string, id = `${from}->${to}#0`): LinkCell => ({
  id,
  type: "link",
  source: { id: from },
  target: { id: to },
});

const liveLink = (id: string, source: unknown, target: unknown, opacity = 1): LiveLink => ({
  id,
  source,
  target,
  opacity,
});

describe("diffCells", () => {
  it("matches steps by id: kept, new and gone", () => {
    const diff = diffCells(
      { elements: [{ id: "a" }, { id: "b" }], links: [] },
      [el("b", 10), el("c")],
    );
    expect(diff.update.map((c) => c.id)).toEqual(["b"]);
    expect(diff.update[0]!.position.x).toBe(10);
    expect(diff.enter.map((c) => c.id)).toEqual(["c"]);
    expect(diff.exit).toEqual(["a"]);
  });

  it("matches edges by the steps they join, not by the link's own id", () => {
    // The index in a link id shifts when an earlier edge goes; the edge is the same edge.
    const diff = diffCells(
      { elements: [], links: [liveLink("a->b#3", "a", "b"), liveLink("b->c#4", "b", "c")] },
      [link("a", "b", "a->b#0"), link("c", "d")],
    );
    expect(diff.linkUpdate).toEqual([{ liveId: "a->b#3", cell: link("a", "b", "a->b#0") }]);
    expect(diff.linkEnter.map((c) => c.id)).toEqual(["c->d#0"]);
    expect(diff.linkExit).toEqual(["b->c#4"]);
  });

  it("keeps one of two drawn links that join the same pair, since the spec holds them as one", () => {
    const diff = diffCells(
      { elements: [], links: [liveLink("drawn-1", "a", "b"), liveLink("drawn-2", "a", "b")] },
      [link("a", "b")],
    );
    expect(diff.linkUpdate.map((u) => u.liveId)).toEqual(["drawn-1"]);
    expect(diff.linkExit).toEqual(["drawn-2"]);
  });

  it("drops a link left dangling, which the spec never held", () => {
    const diff = diffCells({ elements: [], links: [liveLink("loose", "a", undefined)] }, []);
    expect(diff.linkExit).toEqual(["loose"]);
  });
});

describe("planTracks", () => {
  const box = (x: number, y: number): Box => ({ x, y, width: 100, height: 40 });

  it("moves a kept step from where it is drawn now, and leaves a still one alone", () => {
    const live = {
      elements: [
        { id: "moves", box: box(0, 300), opacity: 1 },
        { id: "still", box: box(0, 0), opacity: 1 },
      ],
      links: [],
    };
    const next = [el("moves", 0, 100), el("still", 0, 0)];
    const tracks = planTracks(live, diffCells(live, next));
    expect(tracks).toEqual([
      { id: "moves", from: { opacity: 1, box: box(0, 300) }, to: { opacity: 1, box: box(0, 100) } },
    ]);
  });

  it("fades a new step in where it will stay, and a gone one out where it is", () => {
    const live = { elements: [{ id: "gone", box: box(5, 5), opacity: 1 }], links: [] };
    const tracks = planTracks(live, diffCells(live, [el("new", 40, 80)]));
    expect(tracks).toEqual([
      { id: "new", from: { opacity: 0, box: box(40, 80) }, to: { opacity: 1, box: box(40, 80) } },
      { id: "gone", from: { opacity: 1, box: box(5, 5) }, to: { opacity: 0, box: box(5, 5) } },
    ]);
  });

  it("brings back a step that was part way through leaving", () => {
    const live = { elements: [{ id: "back", box: box(0, 0), opacity: 0.4 }], links: [] };
    const [track] = planTracks(live, diffCells(live, [el("back")]));
    expect(track!.from.opacity).toBe(0.4);
    expect(track!.to.opacity).toBe(1);
  });

  it("gives an edge only opacity: its path follows the steps it joins", () => {
    const live = { elements: [], links: [] };
    expect(planTracks(live, diffCells(live, [link("a", "b")]))).toEqual([
      { id: "a->b#0", from: { opacity: 0 }, to: { opacity: 1 } },
    ]);
  });
});

describe("ease and frameAt", () => {
  const track = {
    id: "a",
    from: { opacity: 0, box: { x: 0, y: 0, width: 100, height: 40 } },
    to: { opacity: 1, box: { x: 200, y: 400, width: 120, height: 40 } },
  };

  it("starts at the start, ends exactly at the target, and never runs backwards", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
    for (let t = 0; t < 1; t += 0.05) expect(ease(t + 0.05)).toBeGreaterThanOrEqual(ease(t));
    expect(frameAt(track, 0)).toEqual(track.from);
    expect(frameAt(track, 1)).toBe(track.to);
    expect(frameAt(track, 7)).toBe(track.to);
  });

  it("is deterministic: the same instant gives the same frame", () => {
    expect(frameAt(track, 0.3)).toEqual(frameAt(track, 0.3));
    const mid = frameAt(track, 0.5);
    expect(mid.box).toEqual({ x: 100, y: 200, width: 110, height: 40 });
    expect(mid.opacity).toBeCloseTo(0.5);
  });
});

/** A clock on fake timers: no real time passes in any test below. */
const fakeClock: Clock = {
  now: () => Date.now(),
  request: (callback) => setTimeout(callback, 16),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The live drawing, in memory, standing in for the JointJS graph. */
function memoryTarget(seed: readonly Cell[]) {
  const elements = new Map<string, { box: Box; opacity: number; portMap?: unknown }>();
  const links = new Map<string, { source: unknown; target: unknown; opacity: number }>();
  const writes: string[] = [];

  const put = (cell: Cell) => {
    if (cell.type === "element") {
      elements.set(cell.id, {
        box: { ...cell.position, width: cell.size!.width, height: cell.size!.height },
        opacity: 1,
        portMap: cell.portMap,
      });
    } else {
      links.set(cell.id, { source: cell.source.id, target: cell.target.id, opacity: 1 });
    }
  };
  seed.forEach(put);

  const target: LayoutTarget = {
    elements: () => [...elements].map(([id, e]) => ({ id, box: e.box, opacity: e.opacity })),
    links: () => [...links].map(([id, l]) => ({ id, ...l })),
    put: (cell) => {
      writes.push(`put ${cell.id}`);
      put(cell);
    },
    patch: (id, attributes) => {
      writes.push(`patch ${id}`);
      const l = links.get(id);
      if (l && attributes.source) {
        l.source = (attributes.source as { id: string }).id;
        l.target = (attributes.target as { id: string }).id;
      }
    },
    remove: (ids) => {
      for (const id of ids) {
        writes.push(`remove ${id}`);
        elements.delete(id);
        links.delete(id);
      }
    },
    draw: (id, frame: Frame) => {
      const e = elements.get(id);
      if (e) {
        e.opacity = frame.opacity;
        if (frame.box) e.box = frame.box;
      }
      const l = links.get(id);
      if (l) l.opacity = frame.opacity;
    },
  };
  return { target, elements, links, writes };
}

describe("Motion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const track = {
    id: "a",
    from: { opacity: 1, box: { x: 0, y: 0, width: 10, height: 10 } },
    to: { opacity: 1, box: { x: 100, y: 0, width: 10, height: 10 } },
  };

  it("draws the first frame at once and the target exactly at the end", () => {
    const drawn: Frame[] = [];
    const done = vi.fn();
    new Motion(fakeClock, (_id, frame) => drawn.push(frame)).play([track], 500, done);
    expect(drawn).toEqual([track.from]);

    vi.advanceTimersByTime(250);
    expect(drawn.at(-1)!.box!.x).toBeGreaterThan(0);
    expect(drawn.at(-1)!.box!.x).toBeLessThan(100);
    expect(done).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(drawn.at(-1)).toBe(track.to);
    expect(done).toHaveBeenCalledOnce();
  });

  it("jumps when the duration is zero, which is what reduced motion asks for", () => {
    expect(motionDuration(true)).toBe(0);
    expect(motionDuration(false)).toBe(MOTION_MS);
    expect(MOTION_MS).toBeGreaterThanOrEqual(400);
    expect(MOTION_MS).toBeLessThanOrEqual(700);

    const request = vi.fn();
    const drawn: Frame[] = [];
    const done = vi.fn();
    new Motion({ ...fakeClock, request }, (_id, frame) => drawn.push(frame)).play(
      [track],
      motionDuration(true),
      done,
    );
    expect(drawn).toEqual([track.to]);
    expect(request).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("never finishes a tween that a newer one interrupted", () => {
    const first = vi.fn();
    const motion = new Motion(fakeClock, () => {});
    motion.play([track], 500, first);
    vi.advanceTimersByTime(200);
    const second = vi.fn();
    motion.play([track], 500, second);
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("syncLayout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const picture = (repaired: boolean) => {
    const model = buildModel(FIXTURES["linear-chain"]!, repaired);
    if (!model.ok) throw new Error(model.error);
    return specToGraph(model, model.graph.spec.nodes);
  };
  const boxes = (cells: readonly Cell[]) =>
    new Map(
      cells
        .filter((c): c is ElementCell => c.type === "element")
        .map((c) => [c.id, { ...c.position, width: c.size!.width, height: c.size!.height }]),
    );

  it("collapses the chain into its waves by moving the same boxes, not by redrawing them", () => {
    const asWritten = picture(false);
    const repaired = picture(true);
    const { target, elements, links, writes } = memoryTarget(asWritten);

    syncLayout(target, repaired, new Motion(fakeClock, target.draw), MOTION_MS);

    // Every step stays on the graph; none is put or removed.
    const stepIds = new Set(boxes(asWritten).keys());
    expect(writes.filter((w) => /^(put|remove) /.test(w) && stepIds.has(w.split(" ")[1]!))).toEqual(
      [],
    );
    // The edges that carried nothing are gone at once, and the drawing holds
    // exactly the repaired picture's edges.
    const fake = asWritten.filter((c) => c.type === "link" && c.data?.fake === true);
    expect(fake.length).toBe(2);
    for (const c of fake) expect(writes).toContain(`remove ${c.id}`);
    const keys = (all: Iterable<{ source: unknown; target: unknown }>) =>
      [...all].map((l) => `${String(l.source)}->${String(l.target)}`).sort();
    expect(keys(links.values())).toEqual(
      keys(
        repaired
          .filter((c): c is LinkCell => c.type === "link")
          .map((c) => ({ source: c.source.id, target: c.target.id })),
      ),
    );

    // Half-way, the boxes that rise are part of the way up.
    const before = boxes(asWritten).get("lint_docs")!;
    const after = boxes(repaired).get("lint_docs")!;
    expect(after.y).toBeLessThan(before.y);
    vi.advanceTimersByTime(MOTION_MS / 2);
    const mid = elements.get("lint_docs")!.box;
    expect(mid.y).toBeLessThan(before.y);
    expect(mid.y).toBeGreaterThan(after.y);

    vi.advanceTimersByTime(MOTION_MS);
    for (const [id, box] of boxes(repaired)) expect(elements.get(id)!.box).toEqual(box);
  });

  it("retargets from where the boxes are when a second edit lands mid-move", () => {
    const asWritten = picture(false);
    const { target, elements } = memoryTarget(asWritten);
    const drawn: Box[] = [];
    const motion = new Motion(fakeClock, (id, frame) => {
      target.draw(id, frame);
      if (id === "lint_docs") drawn.push(frame.box!);
    });

    syncLayout(target, picture(true), motion, MOTION_MS);
    vi.advanceTimersByTime(MOTION_MS / 2);
    const mid = elements.get("lint_docs")!.box;

    // Toggled straight back: the box sets off from the middle, with no jump.
    drawn.length = 0;
    syncLayout(target, asWritten, motion, MOTION_MS);
    expect(drawn[0]).toEqual(mid);
    vi.advanceTimersByTime(16);
    expect(drawn[1]!.y).toBeGreaterThan(mid.y);

    vi.advanceTimersByTime(MOTION_MS);
    expect(elements.get("lint_docs")!.box).toEqual(boxes(asWritten).get("lint_docs"));
  });

  it("fades a removed step out and only then takes it off the graph", () => {
    const { target, elements } = memoryTarget([el("a"), el("b", 0, 100)]);
    syncLayout(target, [el("a")], new Motion(fakeClock, target.draw), MOTION_MS);
    expect(elements.has("b")).toBe(true);
    vi.advanceTimersByTime(MOTION_MS / 2);
    expect(elements.get("b")!.opacity).toBeGreaterThan(0);
    expect(elements.get("b")!.opacity).toBeLessThan(1);
    vi.advanceTimersByTime(MOTION_MS);
    expect(elements.has("b")).toBe(false);
  });

  it("with reduced motion, lands every box at once and removes what left", () => {
    const { target, elements } = memoryTarget([el("a", 0, 300), el("b")]);
    syncLayout(target, [el("a", 0, 100)], new Motion(fakeClock, target.draw), motionDuration(true));
    expect(elements.get("a")!.box.y).toBe(100);
    expect(elements.has("b")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-attaches a link drawn to a port before touching the steps' ports", () => {
    const drawnToPort: Cell = {
      id: "drawn",
      type: "link",
      source: { id: "a", port: "out:x" },
      target: { id: "b", port: "in:x" },
    };
    const { target, writes } = memoryTarget([el("a"), el("b", 0, 100), drawnToPort]);
    syncLayout(target, [el("a"), el("b", 0, 100), link("a", "b")], new Motion(fakeClock, target.draw), 0);
    expect(writes).toEqual(["patch drawn", "patch a", "patch b"]);
  });
});
