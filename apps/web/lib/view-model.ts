// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-neutral node/edge shapes.
 *
 * `graph-model.ts`, `overlay.ts`, `heat.ts` and `capability.ts` depend on these
 * instead of on a canvas library's own types, so swapping the canvas draws a
 * line at this file rather than at every overlay. Carries exactly the fields
 * those four files actually read or write — nothing speculative.
 */

export interface CCPosition {
  readonly x: number;
  readonly y: number;
}

export interface CCNode {
  readonly id: string;
  readonly position: CCPosition;
  readonly data: Record<string, unknown>;
  readonly type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly draggable?: boolean;
  readonly className?: string;
  readonly style?: Record<string, string | number | undefined>;
}

export interface CCEdgeMarker {
  readonly type: string;
  readonly color?: string;
}

export interface CCEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
  readonly animated?: boolean;
  readonly className?: string;
  readonly style?: Record<string, string | number | undefined>;
  readonly labelStyle?: Record<string, string | number | undefined>;
  readonly labelBgStyle?: Record<string, string | number | undefined>;
  readonly markerEnd?: CCEdgeMarker;
  readonly data?: Record<string, unknown>;
}
