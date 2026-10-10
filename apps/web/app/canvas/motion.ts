// SPDX-License-Identifier: Apache-2.0
import type { Cell, ElementCell, LinkCell } from "./bridge.js";

/**
 * How the canvas moves from one laid-out picture to the next.
 *
 * Layout still decides every pixel. This file only interpolates between two
 * pictures layout has already computed: where a box is drawn now, and where
 * the new declarations put it. Nothing here invents a position.
 *
 * Dependency-free, like bridge.ts, so the diff and the tween run in plain Node
 * tests with no DOM and no real clock. canvas.tsx supplies the two impure
 * parts: a `LayoutTarget` over the live `dia.Graph`, and a `Clock` over
 * `requestAnimationFrame`.
 */

/** Long enough to follow a box across the canvas, short enough not to wait for. */
export const MOTION_MS = 550;

/** Zero when the reader has asked for less motion: every change is a jump. */
export function motionDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : MOTION_MS;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What one cell looks like at one instant. Links have no box of their own. */
export interface Frame {
  readonly opacity: number;
  readonly box?: Box;
}

export interface Track {
  readonly id: string;
  readonly from: Frame;
  readonly to: Frame;
}

/** An element as currently drawn: mid-tween, if a tween is running. */
export interface LiveElement {
  readonly id: string;
  readonly box: Box;
  readonly opacity: number;
}

/** A link as currently drawn. `source`/`target` are endpoint ids, undefined when dangling. */
export interface LiveLink {
  readonly id: string;
  readonly source: unknown;
  readonly target: unknown;
  readonly opacity: number;
}

/** An edge is the same edge across two pictures when it joins the same two steps. */
export function edgeKey(source: unknown, target: unknown): string {
  return `${String(source)}->${String(target)}`;
}

export interface CellDiff {
  /** Steps new to this picture, in the order the new picture lists them. */
  readonly enter: readonly ElementCell[];
  /** Steps in both pictures (matched by id), carrying their new cell. */
  readonly update: readonly ElementCell[];
  /** Ids of steps the new picture no longer has. */
  readonly exit: readonly string[];
  readonly linkEnter: readonly LinkCell[];
  /** Edges in both pictures. `liveId` is the drawn link's own id, which is kept. */
  readonly linkUpdate: readonly { readonly liveId: string; readonly cell: LinkCell }[];
  /** Ids of drawn links the new picture no longer has. */
  readonly linkExit: readonly string[];
}

/**
 * Steps match by id and edges by `from->to`, never by a link's own id: a
 * link's id carries its index in the edge list (graph-model.ts), which shifts
 * whenever an earlier edge is added or dropped, and a link someone drew on
 * the canvas has an id JointJS made up. When two drawn links join the same
 * pair (one per port), the first is kept and the rest leave, because the spec
 * holds them as one edge (bridge.ts's `graphToSpec`).
 */
export function diffCells(
  live: { readonly elements: readonly { readonly id: string }[]; readonly links: readonly LiveLink[] },
  next: readonly Cell[],
): CellDiff {
  const liveIds = new Set(live.elements.map((e) => e.id));
  const nextElements = next.filter((c): c is ElementCell => c.type === "element");
  const nextIds = new Set(nextElements.map((c) => c.id));

  const queues = new Map<string, string[]>();
  for (const link of live.links) {
    const key = edgeKey(link.source, link.target);
    queues.set(key, [...(queues.get(key) ?? []), link.id]);
  }

  const linkEnter: LinkCell[] = [];
  const linkUpdate: { liveId: string; cell: LinkCell }[] = [];
  for (const cell of next) {
    if (cell.type !== "link") continue;
    const liveId = queues.get(edgeKey(cell.source.id, cell.target.id))?.shift();
    if (liveId === undefined) linkEnter.push(cell);
    else linkUpdate.push({ liveId, cell });
  }

  return {
    enter: nextElements.filter((c) => !liveIds.has(c.id)),
    update: nextElements.filter((c) => liveIds.has(c.id)),
    exit: live.elements.filter((e) => !nextIds.has(e.id)).map((e) => e.id),
    linkEnter,
    linkUpdate,
    linkExit: [...queues.values()].flat(),
  };
}

function targetBox(cell: ElementCell, fallback?: Box): Box {
  return {
    x: cell.position.x,
    y: cell.position.y,
    width: cell.size?.width ?? fallback?.width ?? 0,
    height: cell.size?.height ?? fallback?.height ?? 0,
  };
}

const sameBox = (a: Box, b: Box) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * One track per cell that has somewhere to go. A step that stays travels from
 * where it is drawn now (which, mid-tween, is part of the way to an older
 * target) to its new box, so a second edit retargets without a jump. A new
 * step fades in where it will stay; a step that leaves fades out where it is.
 * Edges carry only opacity: their path follows the boxes they join.
 */
export function planTracks(
  live: { readonly elements: readonly LiveElement[]; readonly links: readonly LiveLink[] },
  diff: CellDiff,
): Track[] {
  const elements = new Map(live.elements.map((e) => [e.id, e]));
  const links = new Map(live.links.map((l) => [l.id, l]));
  const tracks: Track[] = [];

  for (const cell of diff.update) {
    const now = elements.get(cell.id)!;
    const to = targetBox(cell, now.box);
    if (sameBox(now.box, to) && now.opacity === 1) continue;
    tracks.push({ id: cell.id, from: { opacity: now.opacity, box: now.box }, to: { opacity: 1, box: to } });
  }
  for (const cell of diff.enter) {
    const box = targetBox(cell);
    tracks.push({ id: cell.id, from: { opacity: 0, box }, to: { opacity: 1, box } });
  }
  for (const id of diff.exit) {
    const now = elements.get(id)!;
    tracks.push({ id, from: { opacity: now.opacity, box: now.box }, to: { opacity: 0, box: now.box } });
  }
  for (const { liveId } of diff.linkUpdate) {
    const opacity = links.get(liveId)!.opacity;
    if (opacity !== 1) tracks.push({ id: liveId, from: { opacity }, to: { opacity: 1 } });
  }
  for (const cell of diff.linkEnter) {
    tracks.push({ id: cell.id, from: { opacity: 0 }, to: { opacity: 1 } });
  }
  return tracks;
}

/** Slow out, slow in: a box sets off gently and settles rather than stopping dead. */
export function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where a track is at `t` (0 to 1, clamped), eased. At 1 it is exactly the target. */
export function frameAt(track: Track, t: number): Frame {
  if (t >= 1) return track.to;
  const k = ease(Math.max(0, t));
  const { from, to } = track;
  return {
    opacity: lerp(from.opacity, to.opacity, k),
    box:
      from.box && to.box
        ? {
            x: lerp(from.box.x, to.box.x, k),
            y: lerp(from.box.y, to.box.y, k),
            width: lerp(from.box.width, to.box.width, k),
            height: lerp(from.box.height, to.box.height, k),
          }
        : to.box,
  };
}

export interface Clock {
  now(): number;
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

/**
 * One tween at a time over every moving cell, on one clock, so the boxes
 * travel together. `play` cancels whatever is running and starts from the
 * tracks it is given; the caller builds those from the live drawing, which
 * is what makes an interruption seamless. The first frame is drawn at once,
 * so a step that fades in is never seen at full strength first.
 */
export class Motion {
  private handle: unknown;
  private running = false;

  constructor(
    private readonly clock: Clock,
    private readonly draw: (id: string, frame: Frame) => void,
  ) {}

  /** `onDone` runs only if this tween reaches its end; an interrupted one never calls it. */
  play(tracks: readonly Track[], durationMs: number, onDone?: () => void): void {
    this.stop();
    if (durationMs <= 0 || tracks.length === 0) {
      for (const track of tracks) this.draw(track.id, track.to);
      onDone?.();
      return;
    }
    const start = this.clock.now();
    this.running = true;
    const tick = () => {
      const t = Math.min(1, (this.clock.now() - start) / durationMs);
      for (const track of tracks) this.draw(track.id, frameAt(track, t));
      if (t < 1) {
        this.handle = this.clock.request(tick);
        return;
      }
      this.running = false;
      onDone?.();
    };
    tick();
  }

  stop(): void {
    if (this.running) this.clock.cancel(this.handle);
    this.running = false;
  }
}

/**
 * The live drawing, as the sync below needs it. Every write a target makes
 * must be marked as the canvas's own, so the canvas -> spec direction
 * (canvas.tsx's `GraphSync`) never mistakes it for a person's edit.
 */
export interface LayoutTarget {
  elements(): readonly LiveElement[];
  links(): readonly LiveLink[];
  /** Add a new cell. */
  put(cell: Cell): void;
  /** Merge attributes over an existing cell. Never its position or size. */
  patch(id: string, attributes: Record<string, unknown>): void;
  remove(ids: readonly string[]): void;
  draw(id: string, frame: Frame): void;
}

/**
 * Bring the drawing to `next` in place. Structure changes at once (a link that
 * the new spec no longer has is gone at once, so nothing drawn ever claims an
 * edge the spec lacks); geometry and fading run through `motion`. A leaving
 * step is removed when its fade ends, or picked up again by the next sync if
 * an edit arrives first.
 */
export function syncLayout(
  target: LayoutTarget,
  next: readonly Cell[],
  motion: Motion,
  durationMs: number,
): void {
  const live = { elements: target.elements(), links: target.links() };
  const diff = diffCells(live, next);
  const tracks = planTracks(live, diff);

  target.remove(diff.linkExit);
  // Links first: a link drawn to a port is re-attached to its step before the
  // step's ports change, so JointJS has no port-bound link of its own to drop.
  for (const { liveId, cell } of diff.linkUpdate) {
    target.patch(liveId, {
      source: cell.source,
      target: cell.target,
      style: cell.style,
      labelMap: cell.labelMap,
      data: cell.data,
    });
  }
  for (const cell of diff.enter) target.put(cell);
  for (const cell of diff.update) target.patch(cell.id, { portMap: cell.portMap ?? {} });
  for (const cell of diff.linkEnter) target.put(cell);

  motion.play(tracks, durationMs, () => target.remove(diff.exit));
}
