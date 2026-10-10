// SPDX-License-Identifier: Apache-2.0
import type { NodeSpec } from "@ccgrapher/core";
import type { CCEdge, CCNode } from "../../lib/view-model.js";

/**
 * The bridge between the framework-neutral model (`lib/graph-model.ts`, already
 * laid out, already linted) and @joint/react's own cell shape.
 *
 * Deliberately dependency-free — no runtime import of `@joint/react` or
 * `@joint/core`. The shapes below are structurally identical to what
 * `<GraphProvider initialCells={...}>` expects, so canvas.tsx can hand this
 * output straight to it, but this file never touches `document` and can be
 * unit-tested in the same plain-Node vitest environment as the rest of `lib/`.
 *
 * `specToGraph` does not recompute layout or lint — `buildModel` already did
 * both. Its only job here is port placement and cell-shape translation.
 */

export interface PortSpec {
  readonly cx?: string | number;
  readonly cy?: string | number;
  readonly width?: number;
  readonly height?: number;
  readonly color?: string;
  readonly label?: string;
  readonly labelPosition?: string;
  readonly passive?: boolean;
}

export interface ElementCell {
  readonly id: string;
  readonly type: "element";
  readonly position: { readonly x: number; readonly y: number };
  readonly size?: { readonly width: number; readonly height: number };
  readonly data: Record<string, unknown>;
  readonly portMap?: Record<string, PortSpec>;
}

export interface LinkStyle {
  readonly color?: string;
  readonly width?: number;
  readonly dasharray?: string;
  readonly targetMarker?: { readonly type: "path"; readonly d: string; readonly fill?: string };
}

export interface LinkLabel {
  readonly text: string;
  readonly position?: number;
  readonly color?: string;
  readonly fontSize?: number;
  readonly backgroundColor?: string;
}

export interface LinkCell {
  readonly id: string;
  readonly type: "link";
  readonly source: { readonly id: string; readonly port?: string };
  readonly target: { readonly id: string; readonly port?: string };
  readonly style?: LinkStyle;
  readonly labelMap?: Record<string, LinkLabel>;
  readonly data?: Record<string, unknown>;
}

/** A plain arrowhead path — JointJS's `targetMarker` accepts this shape directly. */
const arrowMarker = (fill: string) => ({ type: "path" as const, d: "M 10 -5 0 0 10 5 Z", fill });

export type Cell = ElementCell | LinkCell;

/** The one port a step has: the handle a new edge is dragged out of. */
export const OUT_PORT = "out";

/**
 * A step that produces something gets one handle, centred on its bottom edge,
 * the side its outbound edges already leave from. Dragging from it draws a
 * new edge; the field it carries is chosen on the drop (lib/edge-gestures.ts),
 * not by which dot the drag started on, and the drop can land anywhere on the
 * target step, so there are no inbound ports to aim at. A step with an empty
 * `out` has nothing an edge from it could carry, and gets no handle.
 */
function portMapFor(spec: NodeSpec | undefined): Record<string, PortSpec> {
  if (!spec || Object.keys(spec.out).length === 0) return {};
  return { [OUT_PORT]: { cx: "calc(0.5 * w)", cy: "calc(h)", width: 12, height: 12 } };
}

/**
 * `CCNode[]`/`CCEdge[]` (already positioned, already lint-styled by
 * `buildModel`) -> the cell array @joint/react's `GraphProvider` wants.
 *
 * `specNodes` supplies the `in:`/`out:` field maps `portMapFor` reads —
 * `CCNode.data` alone doesn't carry them.
 */
export function specToGraph(
  model: { readonly nodes: readonly CCNode[]; readonly edges: readonly CCEdge[] },
  specNodes: readonly NodeSpec[],
  editable = true,
): Cell[] {
  const byId = new Map(specNodes.map((n) => [n.id, n]));

  const elements: ElementCell[] = model.nodes.map((n) => ({
    id: n.id,
    type: "element",
    position: n.position,
    size:
      n.width !== undefined && n.height !== undefined
        ? { width: n.width, height: n.height }
        : undefined,
    // `n.className`/`n.style` are CCNode's own top-level fields (heat.ts and
    // capability.ts write to them, never to `data`) — but an ElementCell has
    // nowhere else for them to live, since @joint/react's renderElement only
    // ever receives `data`. Carried in under `overlayClassName`/`overlayStyle`
    // rather than merged into the bare keys, so a spec field that happened to
    // be named `className` could never collide with the overlay's own.
    data: { ...n.data, overlayClassName: n.className, overlayStyle: n.style },
    portMap: editable ? portMapFor(byId.get(n.id)) : {},
  }));

  const links: LinkCell[] = model.edges.map((e) => {
    // `e.style` is React Flow's shape (stroke/strokeWidth/strokeDasharray),
    // left over from graph-model.ts having been written for that library —
    // translated here rather than in graph-model.ts, so that file stays
    // canvas-agnostic and only this bridge knows JointJS's own link-style
    // field names (color/width/dasharray).
    const color = (e.style?.stroke as string | undefined) ?? "#6F6660";
    const style: LinkStyle = {
      color,
      width: (e.style?.strokeWidth as number | undefined) ?? 2,
      dasharray: e.style?.strokeDasharray as string | undefined,
      targetMarker: arrowMarker(color),
    };

    return {
      id: e.id,
      type: "link",
      source: { id: e.source },
      target: { id: e.target },
      style,
      labelMap: e.label
        ? {
            main: {
              text: e.label,
              position: 0.5,
              color: (e.labelStyle?.fill as string | undefined) ?? color,
              backgroundColor: (e.labelBgStyle?.fill as string | undefined) ?? "#FBF7F0",
            },
          }
        : undefined,
      // The edge as the spec names it, so a gesture on this link (select,
      // delete, drag an end) can say which edge it means. The link's own id
      // carries an index that shifts as edges come and go.
      data: { ...e.data, from: e.source, to: e.target },
    };
  });

  return [...elements, ...links];
}
