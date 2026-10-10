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
  /** Muted ink that still reads as small text on every node tint (4.5:1). */
  readonly quiet: string;
  /** Danger as small text: `danger` itself is 4.0:1 on the darker node tints. */
  readonly dangerInk: string;
  /**
   * The dashed region around a boundary and its caption. Muted, but dark enough
   * that the caption reads as text on the paper (4.9:1), which `muted` is not.
   */
  readonly boundary: string;
  /**
   * The urgency mark, and the chevrons in it. A blue that no other mark uses,
   * so moving first is never read as a finding (red) or as data (orange).
   */
  readonly urgent: string;
  /**
   * The light wash behind a step that runs at a raised priority, its own or
   * one it inherits by being waited on: the chain an urgent step pulls forward.
   */
  readonly urgentWash: string;
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
  quiet: "#675F58",
  dangerInk: "#B03A26",
  boundary: "#736A63",
  urgent: "#2C5D8A",
  urgentWash: "#CCDDEE",
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
