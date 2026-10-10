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
 * drawn on top of each other is a bug nobody should have to find by eye. Several
 * findings on one node therefore share one bottom-left caption, fitted to
 * `bottomLeftRoom`; `findings.ts` decides what it says.
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
 *
 * Urgency is not a slot either, because all four are taken. It sits outside the
 * box on the opposite corner to the finding flag: a small disc on the top-right
 * corner of everything the node draws (the fan-out stack included), holding
 * two chevrons for `urgent` and one for `high`. Who set it goes in the node's
 * `<title>`, so it shows on hover rather than crowding the box. A step that
 * inherits the priority gets no mark of its own, only the wash behind it
 * (`renderPriorityWash`), so the chain reads as one highlighted path ending at
 * the marked step. Neither moves anything: the waves are dependency truth.
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

/** How far the wash reaches beyond what the node draws: inside the finding ring, outside the worktree halo. */
const WASH_GAP = 6;
/** The urgency disc's centre, out from the corner, and its radius: clear of the box itself. */
const PRIORITY_OFFSET = 10;
const PRIORITY_RADIUS = 8.5;
/** One chevron: half its width, and how thick its arms are, vertically. */
const CHEVRON_HALF = 5;
const CHEVRON_THICK = 2.8;

/**
 * The light wash behind a step at a raised priority. `extent` is everything the
 * node draws, its fan-out stack included. Translucent, and without a stroke, so
 * it reads as a highlighter behind the box and never as a second outline.
 */
export function renderPriorityWash(extent: MarkBox, wash: string): string {
  const box = priorityWashBox(extent);
  return `<rect data-wash="priority" x="${r(box.x)}" y="${r(box.y)}" width="${r(box.width)}" height="${r(box.height)}" rx="8" fill="${wash}" opacity="0.9"/>`;
}

/** Where the wash lies, so a mark placed outside the box can keep clear of it. */
export function priorityWashBox(extent: MarkBox): MarkBox {
  return {
    x: extent.x - WASH_GAP,
    y: extent.y - WASH_GAP,
    width: extent.width + WASH_GAP * 2,
    height: extent.height + WASH_GAP * 2,
  };
}

/** Where the urgency disc sits, so a mark placed outside the box can keep clear of it. */
export function priorityDisc(extent: MarkBox): { cx: number; cy: number; r: number } {
  return { cx: extent.x + extent.width + PRIORITY_OFFSET, cy: extent.y - PRIORITY_OFFSET, r: PRIORITY_RADIUS };
}

/** An upward chevron with its apex at (cx, top). */
function chevron(cx: number, top: number, colour: string): string {
  const w = CHEVRON_HALF;
  const t = CHEVRON_THICK;
  const points = [
    [cx, top],
    [cx + w, top + w],
    [cx + w, top + w + t],
    [cx, top + t],
    [cx - w, top + w + t],
    [cx - w, top + w],
  ];
  return `<polygon points="${points.map(([x, y]) => `${r(x!)},${r(y!)}`).join(" ")}" fill="${colour}"/>`;
}

/**
 * The urgency mark on the top-right corner of `extent`: a disc of paper, so it
 * reads over the wash and any ring, with two chevrons for `urgent` and one for
 * `high`.
 */
export function renderPriorityMark(
  extent: MarkBox,
  priority: "urgent" | "high",
  colour: string,
  ground: string,
): string {
  const { cx, cy } = priorityDisc(extent);
  const height = CHEVRON_HALF + CHEVRON_THICK;
  const chevrons =
    priority === "urgent"
      ? [chevron(cx, cy - (height + 4) / 2, colour), chevron(cx, cy - (height + 4) / 2 + 4, colour)]
      : [chevron(cx, cy - height / 2, colour)];
  return [
    `<g data-mark="priority">`,
    `<circle cx="${r(cx)}" cy="${r(cy)}" r="${PRIORITY_RADIUS}" fill="${ground}" stroke="${colour}" stroke-width="1.2"/>`,
    ...chevrons,
    `</g>`,
  ].join("");
}

/** Advance width per character, as a fraction of font size: what the layout plans labels with. */
const CHAR_RATIO = 0.52;
/** Clear space kept between the two bottom marks. */
const MARK_GAP = 10;

/** Estimated width of a mark's text in its slot. */
export const markWidth = (slot: MarkSlot, text: string): number =>
  text.length * SLOTS[slot].size * CHAR_RATIO;

/**
 * How wide the bottom-left mark may be: the box less its insets and whatever
 * already sits bottom right. A caption is fitted to this before it is placed.
 */
export function bottomLeftRoom(box: MarkBox, marks: readonly Mark[]): number {
  const right = marks.find((m) => m.slot === "bottom-right");
  return box.width - INSET * 2 - (right ? markWidth("bottom-right", right.text) + MARK_GAP : 0);
}
