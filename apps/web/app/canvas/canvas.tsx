"use client";
// SPDX-License-Identifier: Apache-2.0

import type { NodeSpec } from "@ccgrapher/core";
import { dia, linkTools } from "@joint/core";
import {
  GraphProvider,
  Paper,
  usePaper,
  useGraph,
  type CanConnectOptions,
  type CellInput,
} from "@joint/react";
import "@joint/react/styles.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EdgeRef } from "../../lib/edge-gestures";
import type { CCEdge, CCNode } from "../../lib/view-model";
import { specToGraph, type Cell } from "./bridge";
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
 * position, which the picture must never derive from — CLAUDE.md). Nothing the
 * reader does to it is kept as a picture edit: a gesture on an edge (drawing
 * one, dragging an end, deleting one) is reported as what it means for the
 * spec (`EdgeGestures`), the drawing is put back as it was, and the spec edit,
 * if the editor accepts it, moves the drawing to where the new declarations
 * put it. A step dragged by hand slides straight back.
 *
 * Mounted once per loaded spec (the caller's `key`), and framed then. An edit
 * after that changes the drawing in place (`LayoutSync`): boxes travel to
 * where the new declarations put them, and the pan and zoom stay where the
 * reader left them.
 */
/**
 * What a gesture on an edge means, reported to the editor, which turns it into
 * a spec edit (lib/edge-gestures.ts) or a refusal. The canvas decides none of
 * it: it only says which steps and which edge the pointer meant.
 */
export interface EdgeGestures {
  readonly selectedEdge: EdgeRef | undefined;
  readonly onSelectEdge: (edge: EdgeRef) => void;
  /** A new link drawn from `from`'s handle and dropped on `to`. */
  readonly onConnect: (from: string, to: string) => void;
  /** One end of an existing edge dropped on another step. */
  readonly onRetarget: (edge: EdgeRef, end: "from" | "to", node: string) => void;
  readonly onDeleteEdge: (edge: EdgeRef) => void;
  /** A step was dragged and has been sent back to its computed place. */
  readonly onNodeDrag: () => void;
}

/**
 * Every drop on another step reaches the editor, self-loops and duplicates
 * included, so a wrong gesture is refused there with its reason rather than
 * the drop silently failing to land. Only a link onto a link is ruled out
 * here: an edge runs between two steps.
 */
const CONNECTIONS: CanConnectOptions = {
  allowSelfLoops: true,
  allowLinkToLink: false,
  linkLimit: "none",
  allowRootConnection: true,
};

/** A link's own route and labels are drawn from the spec, never dragged. */
const INTERACTIVE: dia.CellView.InteractivityOptions = {
  linkMove: false,
  labelMove: false,
};

export function Canvas({
  nodes,
  edges,
  specNodes,
  onSelect,
  gestures,
}: {
  nodes: readonly CCNode[];
  edges: readonly CCEdge[];
  specNodes: readonly NodeSpec[];
  /** A step clicked (its id) or the blank paper clicked (undefined). Absent in viewer mode. */
  onSelect?: (id: string | undefined) => void;
  /** Absent in viewer mode, which draws no handles and takes no edge gestures. */
  gestures?: EdgeGestures;
}) {
  const editable = gestures !== undefined;
  const cells = useMemo<Cell[]>(
    () => specToGraph({ nodes, edges }, specNodes, editable),
    [nodes, edges, specNodes, editable],
  );
  // The seed only: later pictures reach the mounted graph through LayoutSync.
  const [initialCells] = useState(cells);

  // Read through a ref, so the paper's listeners are bound once and still
  // call the editor's latest handlers (which close over the latest spec).
  const latest = useRef(gestures);
  useEffect(() => {
    latest.current = gestures;
  });

  return (
    <GraphProvider initialCells={initialCells}>
      <LayoutSync cells={cells} latest={latest} />
      <OverlaySync nodes={nodes} />
      <FitOnMount />
      <FitButton />
      <PanZoom />
      {onSelect && <SelectionSync onSelect={onSelect} />}
      {editable && <GestureSync latest={latest} />}
      {editable && <EdgeTools selected={gestures.selectedEdge} cells={cells} latest={latest} />}
      <Paper
        className="jointjs-paper"
        renderElement={SpecNode}
        validateConnection={CONNECTIONS}
        interactive={INTERACTIVE}
        // A link starts only once the pointer leaves the handle, so a click
        // on it draws nothing (and so cannot land as a self-loop refusal).
        magnetThreshold="onleave"
        linkPinning={false}
        defaultLink={{ style: { color: "#E8763A", width: 2, targetMarker: "arrow" } }}
      />
    </GraphProvider>
  );
}

type Latest = { readonly current: EdgeGestures | undefined };

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
 * spec. No graph event is read back as an edit any more (edge gestures come
 * from the paper's pointer events, which these writes never fire), but a
 * listener added to the graph later can still tell the canvas's own writes
 * from a person's by this flag.
 */
const LAYOUT_SYNC = { ccgLayout: true } as const;

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
function LayoutSync({ cells, latest }: { cells: readonly Cell[]; latest: Latest }) {
  const { graph, setCell, removeCells } = useGraph();
  const { paper } = usePaper();
  const drawn = useRef(layoutSignature(cells));
  const current = useRef(cells);

  const motion = useMemo(
    () => new Motion(frameClock, (id, frame) => drawFrame(graph, id, frame)),
    [graph],
  );
  useEffect(() => () => motion.stop(), [motion]);

  const target = useMemo<LayoutTarget>(
    () => ({
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
    }),
    [graph, setCell, removeCells],
  );

  useEffect(() => {
    current.current = cells;
    const signature = layoutSignature(cells);
    if (signature === drawn.current) return;
    drawn.current = signature;
    syncLayout(target, cells, motion, motionDuration(prefersReducedMotion()));
  }, [cells, target, motion]);

  // A step dragged by hand goes straight back to where its dependencies put
  // it, on the same tween an edit uses, and the editor is told once so it can
  // say why (rather than the step snapping back in silence on the next edit).
  useEffect(() => {
    if (!paper) return;
    let pressed: { id: string; x: number; y: number } | undefined;
    const onDown = (view: dia.ElementView) => {
      pressed = { id: String(view.model.id), ...view.model.position() };
    };
    const onUp = (view: dia.ElementView) => {
      const start = pressed;
      pressed = undefined;
      if (!start || start.id !== String(view.model.id)) return;
      const { x, y } = view.model.position();
      if (Math.hypot(x - start.x, y - start.y) < 1) return;
      syncLayout(target, current.current, motion, motionDuration(prefersReducedMotion()));
      latest.current?.onNodeDrag();
    };
    paper.on("element:pointerdown", onDown);
    paper.on("element:pointerup", onUp);
    return () => {
      paper.off("element:pointerdown", onDown);
      paper.off("element:pointerup", onUp);
    };
  }, [paper, target, motion, latest]);

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

/** The spec edge a drawn link stands for (bridge.ts writes it), or undefined for a link being drawn. */
function edgeOf(link: dia.Link): EdgeRef | undefined {
  const data = link.get("data") as { from?: unknown; to?: unknown } | undefined;
  return typeof data?.from === "string" && typeof data.to === "string"
    ? { from: data.from, to: data.to }
    : undefined;
}

/**
 * Edge gestures, read off the paper and handed to the editor as what they
 * mean. The drawing itself is never left changed: a newly drawn link is
 * removed and a dragged end put back where the spec has it, both marked as
 * the canvas's own writes, before the editor hears of the gesture. If the
 * editor accepts it, the spec changes and `LayoutSync` moves the drawing to
 * match; if it refuses, the drawing is already as the spec says.
 *
 * Deferred a tick because `link:connect` fires inside JointJS's own pointerup
 * handling of that very link, which must finish before the link is touched.
 */
function GestureSync({ latest }: { latest: Latest }) {
  const { paper } = usePaper();

  useEffect(() => {
    if (!paper) return;
    const onConnect = (
      linkView: dia.LinkView,
      _evt: dia.Event,
      cellView: dia.CellView,
      _magnet: SVGElement,
      arrowhead: dia.LinkEnd,
    ) => {
      const link = linkView.model;
      const node = String(cellView.model.id);
      setTimeout(() => {
        const edge = edgeOf(link);
        if (edge) {
          link.set({ source: { id: edge.from }, target: { id: edge.to } }, LAYOUT_SYNC);
          latest.current?.onRetarget(edge, arrowhead === "source" ? "from" : "to", node);
        } else {
          const from = link.source().id;
          link.remove(LAYOUT_SYNC);
          if (from !== undefined) latest.current?.onConnect(String(from), node);
        }
      });
    };
    const onLinkClick = (linkView: dia.LinkView) => {
      const edge = edgeOf(linkView.model);
      if (edge) latest.current?.onSelectEdge(edge);
    };
    paper.on("link:connect", onConnect);
    paper.on("link:pointerclick", onLinkClick);
    return () => {
      paper.off("link:connect", onConnect);
      paper.off("link:pointerclick", onLinkClick);
    };
  }, [paper, latest]);

  return null;
}

/**
 * The selected edge wears its tools: a handle at each end to drag onto
 * another step, and a delete button. Re-applied whenever the picture changes,
 * because an edit can replace the link the tools were on.
 */
function EdgeTools({
  selected,
  cells,
  latest,
}: {
  selected: EdgeRef | undefined;
  cells: readonly Cell[];
  latest: Latest;
}) {
  const { paper } = usePaper();
  const { graph } = useGraph();
  const from = selected?.from;
  const to = selected?.to;

  useEffect(() => {
    if (!paper || from === undefined || to === undefined) return;
    const link = graph.getLinks().find((l) => {
      const edge = edgeOf(l);
      return edge?.from === from && edge.to === to;
    });
    const view = link && (paper.findViewByModel(link) as dia.LinkView | undefined);
    if (!view) return;
    view.addTools(
      new dia.ToolsView({
        name: "edge-tools",
        tools: [
          new linkTools.SourceArrowhead(),
          new linkTools.TargetArrowhead(),
          new linkTools.Remove({
            distance: "30%",
            action: () => latest.current?.onDeleteEdge({ from, to }),
          }),
        ],
      }),
    );
    view.el.classList.add("edge-selected");
    return () => {
      view.removeTools();
      view.el.classList.remove("edge-selected");
    };
  }, [paper, graph, from, to, cells, latest]);

  return null;
}
