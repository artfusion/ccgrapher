// SPDX-License-Identifier: Apache-2.0
import type { EdgeSpec, NodeSpec, WorkflowSpec } from "@ccgrapher/core";
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

/** `in:<field>` / `out:<field>` — a port id encodes direction and field name. */
export const inPort = (field: string): string => `in:${field}`;
export const outPort = (field: string): string => `out:${field}`;

/** The field name a port id carries. Inverse of `inPort`/`outPort`. */
export function portField(portId: string): string {
  return portId.slice(portId.indexOf(":") + 1);
}

/**
 * Ports spread evenly along the node's top (inbound) and bottom (outbound)
 * edge — the same top-to-bottom flow the layout already draws. Purely a
 * drag affordance; `graphToSpec` below is what actually reconciles ports
 * back into the one `carries: [...]` list an edge is allowed to have.
 */
function portMapFor(spec: NodeSpec | undefined): Record<string, PortSpec> {
  if (!spec) return {};
  const map: Record<string, PortSpec> = {};

  const inFields = Object.keys(spec.in);
  inFields.forEach((field, i) => {
    map[inPort(field)] = {
      cx: `calc(${(i + 1) / (inFields.length + 1)} * w)`,
      cy: 0,
      width: 8,
      height: 8,
    };
  });

  const outFields = Object.keys(spec.out);
  outFields.forEach((field, i) => {
    map[outPort(field)] = {
      cx: `calc(${(i + 1) / (outFields.length + 1)} * w)`,
      cy: "calc(h)",
      width: 8,
      height: 8,
    };
  });

  return map;
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
    portMap: portMapFor(byId.get(n.id)),
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
      data: e.data,
    };
  });

  return [...elements, ...links];
}

export interface LinkEndpoint {
  readonly id: unknown;
  readonly port: string | null;
}

/**
 * The other direction. Merges every link sharing a `(from, to)` pair into
 * one `EdgeSpec` with a unioned `carries` — non-negotiable, because
 * `examples/diamond.yaml`'s checker edges each carry three fields on one
 * edge, and drawing three separate links there would change
 * `effectiveInboundCount` and fire a spurious `SILENT_FAILURE`.
 *
 * Patches `edges` on the already-parsed spec rather than reconstructing
 * nodes — every field the canvas doesn't model (`model`, `writes`, `uses`,
 * `freshContext`, `expects`, `fanOut`, `worktree`, top-level `goal:`)
 * survives untouched.
 */
export function graphToSpec(
  links: readonly { readonly source: LinkEndpoint; readonly target: LinkEndpoint }[],
  base: WorkflowSpec,
): WorkflowSpec {
  const merged = new Map<string, { from: string; to: string; carries: Set<string> }>();

  for (const link of links) {
    if (link.source.id === undefined || link.target.id === undefined) continue;
    const from = String(link.source.id);
    const to = String(link.target.id);
    if (from === to) continue;

    const key = `${from}->${to}`;
    const entry = merged.get(key) ?? { from, to, carries: new Set<string>() };

    // A field can be named from either end — the target's `in:` port if the
    // drag landed there, the source's `out:` port otherwise. Either way it's
    // one field per port, unioned in.
    if (link.target.port?.startsWith("in:")) entry.carries.add(portField(link.target.port));
    if (link.source.port?.startsWith("out:")) entry.carries.add(portField(link.source.port));

    merged.set(key, entry);
  }

  const edges: EdgeSpec[] = [...merged.values()].map((e) => ({
    from: e.from,
    to: e.to,
    carries: [...e.carries],
  }));

  return { ...base, edges };
}

/**
 * Cheap structural check during drag, before a link ever reaches
 * `graphToSpec`: no self-loops, and direction must run `out:` -> `in:`.
 * Both ends must be real ports — dropping on a node's body rather than a
 * port is not a connection this canvas accepts.
 */
export function validateLinkConnection(
  sourceId: unknown,
  sourcePort: string | null,
  targetId: unknown,
  targetPort: string | null,
): boolean {
  if (sourceId === targetId) return false;
  if (!sourcePort || !targetPort) return false;
  if (!sourcePort.startsWith("out:")) return false;
  if (!targetPort.startsWith("in:")) return false;
  return true;
}
