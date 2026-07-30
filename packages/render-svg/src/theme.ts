// SPDX-License-Identifier: Apache-2.0
import type { NodeKind } from "@ccgrapher/core";

/**
 * Palette taken from the reference figures: sketch strokes on warm paper,
 * orange on the edges and the underline, near-black text.
 */
export interface Theme {
  readonly paper: string;
  readonly ink: string;
  readonly accent: string;
  readonly muted: string;
  readonly danger: string;
  /** Very light per-kind tint so the roles read apart at a glance. */
  readonly fill: Readonly<Record<NodeKind, string>>;
  readonly fontFamily: string;
  readonly titleSize: number;
  readonly goalSize: number;
  readonly roughness: number;
  readonly bowing: number;
}

export const DEFAULT_THEME: Theme = {
  paper: "#FBF7F0",
  ink: "#2B2724",
  accent: "#E8763A",
  muted: "#8A817A",
  danger: "#C4442E",
  fill: {
    goal: "#FFFFFF",
    split: "#FFFFFF",
    worker: "#FFFFFF",
    verifier: "#FDEFE6",
    reduce: "#F1EEE9",
    synthesize: "#FBE3D3",
    gate: "#F6F0DC",
  },
  fontFamily: "'Caveat', 'Patrick Hand', 'Segoe Print', 'Comic Sans MS', cursive",
  titleSize: 30,
  goalSize: 18,
  roughness: 1.35,
  bowing: 1.2,
};
