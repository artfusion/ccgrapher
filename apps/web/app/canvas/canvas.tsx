"use client";
// SPDX-License-Identifier: Apache-2.0

import type { NodeSpec, WorkflowSpec } from "@ccgrapher/core";
import { GraphProvider, Paper, usePaper, useGraph, type ValidateConnection } from "@joint/react";
import "@joint/react/styles.css";
import { useCallback, useEffect, useMemo } from "react";
import type { CCEdge, CCNode } from "../../lib/view-model";
import { graphToSpec, specToGraph, validateLinkConnection, type Cell } from "./bridge";
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
 * Remounted (via `key`, set by the caller) whenever the shape of the graph
 * changes, the same way the React Flow canvas was, so a spec swap gets a
 * fresh layout instead of JointJS trying to tween between two unrelated
 * graphs.
 */
export function Canvas({
  nodes,
  edges,
  specNodes,
  baseSpec,
  onSpecChange,
}: {
  nodes: readonly CCNode[];
  edges: readonly CCEdge[];
  specNodes: readonly NodeSpec[];
  baseSpec: WorkflowSpec;
  onSpecChange: (next: WorkflowSpec) => void;
}) {
  const cells = useMemo<Cell[]>(
    () => specToGraph({ nodes, edges }, specNodes),
    [nodes, edges, specNodes],
  );

  const validateConnection = useCallback<ValidateConnection>(
    ({ source, target }) => validateLinkConnection(source.id, source.port, target.id, target.port),
    [],
  );

  return (
    <GraphProvider initialCells={cells}>
      <GraphSync spec={baseSpec} onSpecChange={onSpecChange} />
      <OverlaySync nodes={nodes} />
      <FitOnMount />
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
    paper?.transformToFitContent({ padding: 24, minScale: 0.2, maxScale: 1.5 });
  }, [paper]);
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
 * fake/lint styling `bridge.ts` computes for a link is static from the
 * moment the graph is built.
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
 * Pulls the live link list straight from `dia.Graph` on every source/target
 * change — not from a React state mirror — so a plain element drag (which
 * touches `position`, not a link's endpoints) never fires this at all. That
 * is how "dragging must not write back" is actually enforced here, not just
 * intended.
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
    // A link's own `source`/`target` change on connect, disconnect and
    // repoint — exactly the three operations the plan calls legitimate.
    graph.on("change:source change:target", commit);
    return () => {
      graph.off("change:source change:target", commit);
    };
  }, [graph, commit]);

  return null;
}
