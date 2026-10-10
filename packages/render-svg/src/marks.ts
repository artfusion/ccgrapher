// SPDX-License-Identifier: Apache-2.0

/**
 * Node marks: the one place that decides where a small annotation sits on a node.
 *
 * A node can carry several at once (how many times it fans out, how many results
 * it expects, what the linter found), and they have to share a box that was
 * sized for its label alone. So each mark names a slot, the slot decides the
 * geometry, and nothing else in the renderer positions an annotation. A new mark
 * is a new `Mark` handed to `renderMarks`; no existing mark moves.
 *
 * Slots are the four inside corners of the box, in paint order:
 *
 *   top-left      what the node is        (the model tier, `strong`; layout adds height for it)
 *   top-right     what the node does      (the fan-out count, `x5`)
 *   bottom-left   what the linter says    (a short caption, `no count guard`)
 *   bottom-right  what the node declares  (the guard, `expects 5`)
 *
 * One mark per slot; a second claim on the same slot throws, because two marks
 * drawn on top of each other is a bug nobody should have to find by eye.
 *
 * Room: a box is at least 132 wide and 52 tall, its label is centred and its
 * icon keeps to the left gutter, so the four corners stay clear of both. Top
 * slots hold about 40px of text; bottom slots about 80px, as long as the
 * opposite bottom slot is empty or short. A longer mark belongs outside the box.
 *
 * The finding halo is not a slot. It wraps the box in a solid ring, danger
 * coloured, with a small flag on its top-left corner, outside the box and clear
 * of every slot. Dashes already mean structure here (a human gate, an isolated
 * worktree), so a finding is told apart by colour and a solid line, never by a
 * new dash.
 */

export type MarkSlot = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface Mark {
  readonly slot: MarkSlot;
  readonly text: string;
  readonly fill: string;
}

export interface MarkBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Paint order. Fixed, so the output never depends on the order marks were built in. */
export const SLOT_ORDER: readonly MarkSlot[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const INSET = 8;

interface SlotGeometry {
  readonly anchor: "start" | "end";
  readonly size: number;
  /** Baseline, measured down from the top edge or up from the bottom edge. */
  readonly baseline: number;
  readonly from: "top" | "bottom";
}

const SLOTS: Record<MarkSlot, SlotGeometry> = {
  "top-left": { anchor: "start", size: 15, baseline: 17, from: "top" },
  "top-right": { anchor: "end", size: 15, baseline: 17, from: "top" },
  "bottom-left": { anchor: "start", size: 12, baseline: 5, from: "bottom" },
  "bottom-right": { anchor: "end", size: 12, baseline: 5, from: "bottom" },
};

const r = (n: number) => Number(n.toFixed(2));

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderMarks(marks: readonly Mark[], box: MarkBox): string {
  const taken = new Set<MarkSlot>();
  for (const mark of marks) {
    if (taken.has(mark.slot)) throw new Error(`two marks claim the ${mark.slot} slot`);
    taken.add(mark.slot);
  }

  return SLOT_ORDER.flatMap((slot) => marks.filter((m) => m.slot === slot))
    .map((mark) => {
      const geometry = SLOTS[mark.slot];
      const x = geometry.anchor === "start" ? box.x + INSET : box.x + box.width - INSET;
      const y =
        geometry.from === "top"
          ? box.y + geometry.baseline
          : box.y + box.height - geometry.baseline;
      return `<text x="${r(x)}" y="${r(y)}" font-size="${geometry.size}" fill="${mark.fill}" text-anchor="${geometry.anchor}">${escapeText(mark.text)}</text>`;
    })
    .join("");
}

const HALO_GAP = 7;
const FLAG_RADIUS = 6.5;

/** A solid ring round the box and a small flag on its top-left corner. */
export function renderFindingHalo(box: MarkBox, colour: string, ground: string): string {
  const cx = box.x - HALO_GAP;
  const cy = box.y - HALO_GAP;
  return [
    `<rect data-halo="finding" x="${r(cx)}" y="${r(cy)}" width="${r(box.width + HALO_GAP * 2)}" height="${r(box.height + HALO_GAP * 2)}" fill="none" stroke="${colour}" stroke-width="1.8" opacity="0.9"/>`,
    `<circle cx="${r(cx)}" cy="${r(cy)}" r="${FLAG_RADIUS}" fill="${colour}"/>`,
    // The exclamation mark is drawn, not typeset, so it needs no font.
    `<ellipse cx="${r(cx)}" cy="${r(cy - 1.6)}" rx="1.1" ry="2.6" fill="${ground}"/>`,
    `<circle cx="${r(cx)}" cy="${r(cy + 3.1)}" r="1.15" fill="${ground}"/>`,
  ].join("");
}
