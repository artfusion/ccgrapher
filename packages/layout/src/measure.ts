// SPDX-License-Identifier: Apache-2.0
import { agentTag, type NodeSpec } from "@ccgrapher/core";

export interface Metrics {
  readonly fontSize: number;
  /** Average glyph width as a fraction of font size. Handwriting faces run narrow. */
  readonly charRatio: number;
  readonly lineHeight: number;
  readonly maxCharsPerLine: number;
  readonly padX: number;
  readonly padY: number;
  readonly minWidth: number;
  readonly minHeight: number;
  /** Extra room on a stacked fanOut card for the offset copies behind it. */
  readonly stackOffset: number;
  /** Left strip reserved for the per-kind line icon. */
  readonly iconGutter: number;
  /**
   * Extra height on a node with a model tier, so the tier mark in the top-left
   * corner clears the label. Only `cheap` and `strong` carry one.
   */
  readonly tierBand: number;
  /** The agent tag: a quieter second line under the label. */
  readonly tagSize: number;
  readonly tagLineHeight: number;
}

export const DEFAULT_METRICS: Metrics = {
  fontSize: 17,
  charRatio: 0.52,
  lineHeight: 21,
  maxCharsPerLine: 18,
  padX: 18,
  padY: 14,
  minWidth: 132,
  minHeight: 52,
  stackOffset: 6,
  iconGutter: 26,
  tierBand: 10,
  tagSize: 14,
  tagLineHeight: 18,
};

/**
 * Greedy word wrap. Labels in this notation are 1-4 words, so this never has to
 * be clever — it just stops a box like "merge into one answer" from stretching
 * the whole row.
 */
export function wrapLabel(label: string, maxChars: number): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [label];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface Measured {
  readonly lines: string[];
  readonly width: number;
  readonly height: number;
}

export function measureNode(node: NodeSpec, m: Metrics = DEFAULT_METRICS): Measured {
  const lines = wrapLabel(node.label, m.maxCharsPerLine);
  const longest = Math.max(...lines.map((l) => l.length));

  const badge = node.fanOut ? ` x${node.fanOut.cap ?? "n"}`.length : 0;
  const tag = agentTag(node);
  const textWidth = Math.max(
    (longest + badge) * m.fontSize * m.charRatio,
    tag ? tag.length * m.tagSize * m.charRatio : 0,
  );
  const textHeight = lines.length * m.lineHeight + (tag ? m.tagLineHeight : 0);

  const stack = node.fanOut ? m.stackOffset * 2 : 0;
  const band = node.model ? m.tierBand : 0;

  return {
    lines,
    width: Math.max(m.minWidth, Math.ceil(textWidth + m.padX * 2 + m.iconGutter)) + stack,
    height: Math.max(m.minHeight, textHeight + m.padY * 2) + band + stack,
  };
}
