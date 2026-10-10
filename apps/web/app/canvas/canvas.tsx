"use client";
// SPDX-License-Identifier: Apache-2.0

import type { NodeSpec, WorkflowSpec } from "@ccgrapher/core";
import type { dia } from "@joint/core";
import {
  GraphProvider,
  Paper,
  usePaper,
  useGraph,
  type CellInput,
  type ValidateConnection,
} from "@joint/react";
import "@joint/react/styles.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CCEdge, CCNode } from "../../lib/view-model";
import { graphToSpec, specToGraph, validateLinkConnection, type Cell } from "./bridge";
import {
  Motion,
  motionDuration,
  syncLayout,
  type Clock,
  type Frame,
  type LayoutTarget,
} from "./motion";
import { SpecNode } from "../spec-node";

/**
 * The canvas itself.
 *
 * Takes the *overlaid* view — `view.nodes`/`view.edges` from editor.tsx,
 * already carrying run state, heat and capability tinting on top of the laid-
 * out, lint-styled base — not the bare `Model`. The overlay seam
 * (`lib/overlay.ts`, `lib/heat.ts`, `lib/capability.ts`) still owns
 * everything about how a node or edge is dressed; this component only adapts
 * whatever it's handed into JointJS cells.
 *
 * `initialCells` — uncontrolled. JointJS owns the live graph (including drag
 * position, which the picture must never derive from — CLAUDE.md), and this
 * component asks it directly, imperatively, only at the two moments that are
 * legitimate spec edits: a link connecting or disconnecting.
 *
 * Mounted once per loaded spec (the caller's `key`), and framed then. An edit
 * after that changes the drawing in place (`LayoutSync`): boxes travel to
 * where the new declarations put them, and the pan and zoom stay where the
 * reader left them.
 */
export function Canvas({
  nodes,
  edges,
  specNodes,
  baseSpec,
  onSpecChange,
  onSelect,
}: {
  nodes: readonly CCNode[];
  edges: readonly CCEdge[];
  specNodes: readonly NodeSpec[];
  baseSpec: WorkflowSpec;
  onSpecChange: (next: WorkflowSpec) => void;
  /** A step clicked (its id) or the blank paper clicked (undefined). Absent in viewer mode. */
  onSelect?: (id: string | undefined) => void;
}) {
  const cells = useMemo<Cell[]>(
    () => specToGraph({ nodes, edges }, specNodes),
    [nodes, edges, specNodes],
  );
  // The seed only: later pictures reach the mounted graph through LayoutSync.
  const [initialCells] = useState(cells);

  const validateConnection = useCallback<ValidateConnection>(
    ({ source, target }) => validateLinkConnection(source.id, source.port, target.id, target.port),
    [],
  );

  return (
    <GraphProvider initialCells={initialCells}>
      <GraphSync spec={baseSpec} onSpecChange={onSpecChange} />
      <LayoutSync cells={cells} />
      <OverlaySync nodes={nodes} />
      <FitOnMount />
      <FitButton />
      <PanZoom />
      {onSelect && <SelectionSync onSelect={onSelect} />}
      <Paper
        className="jointjs-paper"
        renderElement={SpecNode}
        validateConnection={validateConnection}
        defaultLink={{ style: { targetMarker: "arrow" } }}
      />
    </GraphProvider>
  );
}

/**
 * The one-time equivalent of React Flow's `fitView`: frame the whole graph
 * once, right after the paper mounts. Zoom buttons and a live grid are
 * `@joint/react-plus` features (a separate, commercially-licensed package
 * this repo does not depend on) — left out here rather than approximated
 * with a paid API this repo cannot actually call. The dot-grid look survives
 * as a plain CSS background on `.jointjs-paper` instead (globals.css).
 */
function FitOnMount() {
  const { paper } = usePaper();
  useEffect(() => {
    if (paper) fit(paper);
  }, [paper]);
  return null;
}

function fit(paper: dia.Paper) {
  paper.transformToFitContent({ padding: 24, minScale: 0.2, maxScale: 1.5 });
}

/**
 * Framing is the reader's after the first look: an edit never reframes, so
 * this is how to bring the whole graph back into view after panning away.
 */
function FitButton() {
  const { paper } = usePaper();
  return (
    <button
      type="button"
      className="canvas-fit"
      disabled={!paper}
      onClick={() => paper && fit(paper)}
      title="Fit the whole graph in view"
    >
      fit
    </button>
  );
}

/**
 * Marks every write the canvas makes to bring its drawing up to date with the
 * spec, so `GraphSync` can tell it apart from a person drawing a link. Without
 * it, re-attaching a link after an edit would be read back as a new edit and
 * written over the spec text.
 */
const LAYOUT_SYNC = { ccgLayout: true } as const;
const isLayoutSync = (opt: unknown): boolean =>
  (opt as { ccgLayout?: unknown } | undefined)?.ccgLayout === true;

const frameClock: Clock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * What a sync compares: everything layout decides, nothing an overlay does.
 * Step `data` is left out because a run's frames, a heat file and the
 * selection all arrive through it, several times a second while a run is
 * live, and `OverlaySync` already carries them. Were they in here, every
 * frame of a run would restart the tween.
 */
function layoutSignature(cells: readonly Cell[]): string {
  return JSON.stringify(cells.map((c) => (c.type === "element" ? { ...c, data: undefined } : c)));
}

/**
 * Brings the mounted graph to each new picture without rebuilding it, so the
 * change can be watched (app/canvas/motion.ts has the diff and the tween).
 *
 * Links follow their boxes on every frame: JointJS re-routes a link whenever
 * one of its ends moves, and at the size these graphs are drawn that is cheap,
 * so nothing waits for the end of the move to reconnect.
 *
 * Reduced motion is read at each sync rather than once, so changing the
 * setting takes effect on the next edit without a reload.
 */
function LayoutSync({ cells }: { cells: readonly Cell[] }) {
  const { graph, setCell, removeCells } = useGraph();
  const drawn = useRef(layoutSignature(cells));

  const motion = useMemo(
    () => new Motion(frameClock, (id, frame) => drawFrame(graph, id, frame)),
    [graph],
  );
  useEffect(() => () => motion.stop(), [motion]);

  useEffect(() => {
    const signature = layoutSignature(cells);
    if (signature === drawn.current) return;
    drawn.current = signature;

    const target: LayoutTarget = {
      elements: () =>
        graph.getElements().map((el) => ({
          id: String(el.id),
          box: { ...el.position(), ...el.size() },
          opacity: opacityOf(el),
        })),
      links: () =>
        graph.getLinks().map((link) => ({
          id: String(link.id),
          source: link.source().id,
          target: link.target().id,
          opacity: opacityOf(link),
        })),
      // bridge.ts's cells are structurally the records @joint/react takes
      // (they seed `initialCells` the same way); its record types are wider.
      put: (cell) => setCell(cell as CellInput, LAYOUT_SYNC),
      patch: (id, attributes) => setCell({ id, ...attributes } as CellInput, LAYOUT_SYNC),
      remove: (ids) => removeCells(ids, LAYOUT_SYNC),
      draw: (id, frame) => drawFrame(graph, id, frame),
    };
    syncLayout(target, cells, motion, motionDuration(prefersReducedMotion()));
  }, [cells, graph, setCell, removeCells, motion]);

  return null;
}

function opacityOf(cell: dia.Cell): number {
  const value: unknown = cell.attr("root/opacity");
  return typeof value === "number" ? value : 1;
}

function drawFrame(graph: dia.Graph, id: string, frame: Frame) {
  const cell = graph.getCell(id);
  if (!cell) return;
  if (frame.box && cell.isElement()) {
    const { x, y, width, height } = frame.box;
    cell.set({ position: { x, y }, size: { width, height } }, LAYOUT_SYNC);
  }
  cell.attr("root/opacity", frame.opacity, LAYOUT_SYNC);
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

/**
 * Mouse-wheel zoom and drag-to-pan, hand-rolled on core JointJS APIs —
 * `ui.PaperScroller` (the `@joint/react-plus` equivalent of this) was left
 * out of the migration as a paid dependency this repo doesn't take, but
 * "no zoom buttons" turned out to mean "no way to move the canvas at all,"
 * which is a real gap, not a cosmetic one.
 *
 * Zoom is anchored at the cursor: `clientToLocalPoint` reads where the
 * cursor sits in the paper's own coordinate space *before* the scale
 * changes, then after rescaling, `localToClientPoint` is used to measure how
 * far that same point drifted on screen, and `translate` corrects by exactly
 * that drift. Anchoring at a fixed origin instead (paper (0,0), say) would
 * make the content jump under the cursor on every scroll tick — technically
 * a zoom, but not a usable one.
 *
 * Pan only starts from `blank:pointerdown` — a drag beginning on a node, a
 * port or a link is JointJS's own gesture (move, connect) and must not also
 * pan underneath it. `evt.clientX`/`clientY` deltas map to `translate`
 * 1:1 regardless of the current scale, because `translate` (tx, ty) are the
 * final additive terms of the paper's transform matrix — applied *after*
 * scale, in already-rendered pixel space — so no scale correction is needed
 * here the way it is for the zoom anchor above.
 */
function PanZoom() {
  const { paper } = usePaper();

  useEffect(() => {
    if (!paper) return;

    const onWheel = (evt: WheelEvent) => {
      evt.preventDefault();
      const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
      const current = paper.scale().sx;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor));
      if (next === current) return;

      const clientPoint = { x: evt.clientX, y: evt.clientY };
      const localPoint = paper.clientToLocalPoint(clientPoint.x, clientPoint.y);
      paper.scale(next, next);
      const driftedPoint = paper.localToClientPoint(localPoint.x, localPoint.y);
      const translate = paper.translate();
      paper.translate(
        translate.tx + (clientPoint.x - driftedPoint.x),
        translate.ty + (clientPoint.y - driftedPoint.y),
      );
    };

    paper.el.addEventListener("wheel", onWheel, { passive: false });

    const onBlankPointerDown = (evt: MouseEvent & { data?: unknown }) => {
      evt.data = {
        startClientX: evt.clientX,
        startClientY: evt.clientY,
        startTranslate: paper.translate(),
      };
    };
    const onBlankPointerMove = (evt: MouseEvent & { data?: unknown }) => {
      const data = evt.data as
        | { startClientX: number; startClientY: number; startTranslate: { tx: number; ty: number } }
        | undefined;
      if (!data) return;
      paper.translate(
        data.startTranslate.tx + (evt.clientX - data.startClientX),
        data.startTranslate.ty + (evt.clientY - data.startClientY),
      );
    };

    paper.on("blank:pointerdown", onBlankPointerDown);
    paper.on("blank:pointermove", onBlankPointerMove);

    return () => {
      paper.el.removeEventListener("wheel", onWheel);
      paper.off("blank:pointerdown", onBlankPointerDown);
      paper.off("blank:pointermove", onBlankPointerMove);
    };
  }, [paper]);

  return null;
}

/**
 * A click on a step selects it for the inspector; a click on blank paper
 * clears the selection. JointJS's `pointerclick` events fire only for a press
 * that did not travel, so dragging a step or panning the paper selects
 * nothing. Selection is read here and written nowhere on the graph: the card
 * learns it is selected the way it learns everything else, through `data`.
 */
function SelectionSync({ onSelect }: { onSelect: (id: string | undefined) => void }) {
  const { paper } = usePaper();

  useEffect(() => {
    if (!paper) return;
    const onElement = (view: dia.ElementView) => onSelect(String(view.model.id));
    const onBlank = () => onSelect(undefined);
    paper.on("element:pointerclick", onElement);
    paper.on("blank:pointerclick", onBlank);
    return () => {
      paper.off("element:pointerclick", onElement);
      paper.off("blank:pointerclick", onBlank);
    };
  }, [paper, onSelect]);

  return null;
}

/**
 * `initialCells` seeds the graph once, on mount, by design — that is what
 * keeps a drag from ever round-tripping through React state. But it also
 * means a later change to `nodes` (a heat file dropped, a live run's SSE
 * frame, a capability alert appearing) would silently stop reaching an
 * already-mounted node, because nothing tells JointJS to look again.
 *
 * This is the fix, and it is narrow on purpose: `setCellData` only ever
 * touches a cell's `data`, never its `position` or `size` — the exact same
 * boundary `lib/overlay.ts`'s "may only add to data" rule already draws.
 * Links need no equivalent: heat has nothing to say about an edge, and the
 * fake/lint styling `bridge.ts` computes for a link changes only with the
 * spec, which `LayoutSync` carries. Placed after `LayoutSync`, so a step an
 * edit has just added is already on the graph when its data arrives.
 */
function OverlaySync({ nodes }: { nodes: readonly CCNode[] }) {
  const { setCellData } = useGraph();

  useEffect(() => {
    for (const n of nodes) {
      setCellData(n.id, () => ({
        ...n.data,
        overlayClassName: n.className,
        overlayStyle: n.style,
      }));
    }
  }, [nodes, setCellData]);

  return null;
}

/**
 * Pulls the live link list straight from `dia.Graph` — not from a React
 * state mirror — so a plain element drag (which touches `position`, not a
 * link's endpoints) never fires this at all. That is how "dragging must not
 * write back" is actually enforced here, not just intended.
 *
 * Two event families, not one. `change:source`/`change:target` fires when an
 * *existing* link's endpoint changes — a disconnect (endpoint goes to null)
 * or a repoint. It does **not** fire for a brand-new link: JointJS sets
 * `source`/`target` at construction, and a model's own constructor setting
 * its own initial attributes is not a "change" for Backbone/JointJS's
 * purposes. A first pass here subscribed only to `change:*` and a live drag
 * test caught it directly: three links really were created in `dia.Graph`
 * (confirmed via `graph.getLinks()`), but none of them ever reached
 * `graphToSpec` — a drawn edge was being silently dropped, not merely
 * unverified. `add`/`remove`, filtered to links, is what a genuine connect
 * or a link being deleted outright actually fires.
 *
 * The `add`/`remove` fix above shipped a second bug of its own, also caught
 * live: `initialCells` seeds the graph one cell at a time, and a fixture
 * switch tears the old graph down the same way, so a single mount or
 * teardown fires a *burst* of `add`/`remove` events. Reading
 * `graph.getLinks()` synchronously from inside the very first handler in
 * that burst catches the graph mid-mutation — a live test wrote `edges: []`
 * to the actual YAML source because the first `add` fired before the rest
 * of the initial seed had landed. `scheduleCommit` collapses a burst into
 * one read, deferred to a microtask so it always runs after the current
 * synchronous batch of graph mutations has fully settled. `cancelled`
 * guards the case where that microtask is still pending when this effect's
 * own cleanup runs (unmounting mid-burst) — without it, a stale commit could
 * fire after the fact against a torn-down graph.
 */
function GraphSync({
  spec,
  onSpecChange,
}: {
  spec: WorkflowSpec;
  onSpecChange: (next: WorkflowSpec) => void;
}) {
  const { graph } = useGraph();

  const commit = useCallback(() => {
    const links = graph.getLinks().map((link) => {
      const source = link.source();
      const target = link.target();
      return {
        source: { id: source.id, port: (source.port as string | undefined) ?? null },
        target: { id: target.id, port: (target.port as string | undefined) ?? null },
      };
    });
    onSpecChange(graphToSpec(links, spec));
  }, [graph, spec, onSpecChange]);

  useEffect(() => {
    let cancelled = false;
    let scheduled = false;

    const scheduleCommit = () => {
      if (scheduled || cancelled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!cancelled) commit();
      });
    };

    // The canvas's own writes (`LAYOUT_SYNC`) are the spec arriving, not an edit.
    const onEndpoint = (_link: unknown, _value: unknown, opt?: unknown) => {
      if (!isLayoutSync(opt)) scheduleCommit();
    };
    const onAddOrRemove = (cell: { isLink: () => boolean }, _collection: unknown, opt?: unknown) => {
      if (cell.isLink() && !isLayoutSync(opt)) scheduleCommit();
    };

    graph.on("change:source change:target", onEndpoint);
    graph.on("add remove", onAddOrRemove);
    return () => {
      cancelled = true;
      graph.off("change:source change:target", onEndpoint);
      graph.off("add remove", onAddOrRemove);
    };
  }, [graph, commit]);

  return null;
}
