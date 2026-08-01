// SPDX-License-Identifier: Apache-2.0
import type { InstanceCounts, NodeRunState, Usage } from "@ccgrapher/trace";

/**
 * What a run said about one node, put into words.
 *
 * Formatting only. Nothing here reads the graph, and nothing here can move a
 * node — the pop-over that renders these rows is a `data.run` consumer like any
 * other overlay, and `lib/overlay.ts` explains why that matters.
 *
 * The rule this file exists to hold:
 *
 *   **absent is not zero.**
 *
 * Every field of `Usage` is optional, and an absent one means nobody measured
 * it. A measured £0 and an unmeasured cost look identical the moment either is
 * printed as `0`, and they mean opposite things — one says this node was free,
 * the other says we have no idea what this node was. So an absent value becomes
 * the word `not recorded`, a present zero becomes `0`, and no row is ever
 * dropped for being empty: a missing row reads as a zero too, just more quietly.
 */

/** The one phrase that stands for "nobody measured this". */
export const NOT_RECORDED = "not recorded";

/**
 * One line of the pop-over.
 *
 * `recorded` is the whole point: it lets the renderer show an unmeasured value
 * differently from a measured one without either of them disappearing.
 */
export interface DetailRow {
  readonly label: string;
  readonly value: string;
  readonly recorded: boolean;
}

function known(label: string, value: string): DetailRow {
  return { label, value, recorded: true };
}

function unknown(label: string): DetailRow {
  return { label, value: NOT_RECORDED, recorded: false };
}

const STATUS_WORD: Record<NodeRunState["status"], string> = {
  pending: "not reached yet",
  running: "running",
  waiting: "waiting on a human",
  done: "done",
  failed: "failed",
  partial: "some instances still out",
};

export function formatStatus(status: NodeRunState["status"]): string {
  return STATUS_WORD[status];
}

/**
 * A duration nobody timed is `not recorded`; a duration of 0 ms is `0 ms`.
 *
 * `node_failed` carries `durationMs` as optional on purpose — a node can fail
 * before anything starts a clock — so this case is ordinary, not exotic.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return NOT_RECORDED;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} m ${Math.round((ms - minutes * 60_000) / 1000)} s`;
}

/** Thousands-grouped by hand, so the same trace reads the same in every locale. */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return NOT_RECORDED;
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Cost, to as many places as it takes to stay true.
 *
 * A fifth of a cent rounded to two places is `$0.00`, which is the exact lie
 * this project is about, so the number of decimals follows the magnitude and a
 * value too small for even six places is reported as a bound rather than as
 * zero. `0` itself prints as `$0.0000`, because a measured zero is a fact.
 */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return NOT_RECORDED;
  // Zero is a measurement, not a small number, so it does not go through the
  // magnitude ladder below — that would drop it into the six-place branch and
  // print `$0.000000`, which reads as a rounding artefact rather than a fact.
  if (usd === 0) return "$0.0000";
  const decimals = usd >= 0.01 ? 2 : usd >= 0.0001 ? 4 : 6;
  const text = usd.toFixed(decimals);
  if (usd > 0 && Number(text) === 0) return `< $${(10 ** -decimals).toFixed(decimals)}`;
  return `$${text}`;
}

/**
 * When the node started, in the reader's own clock.
 *
 * `ts` is a plain string in the contract because a writer that emits `+00:00`
 * instead of `Z` is still telling the truth. One that emits something else
 * entirely is shown verbatim rather than dropped or guessed at.
 */
export function formatStartedAt(ts: string | undefined): string {
  if (ts === undefined) return NOT_RECORDED;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return ts;
  return at.toLocaleTimeString();
}

/** Status, start and duration. Always three rows, whatever the trace left out. */
export function timingRows(run: NodeRunState): DetailRow[] {
  return [
    known("status", formatStatus(run.status)),
    run.startedAt === undefined
      ? unknown("started")
      : known("started", formatStartedAt(run.startedAt)),
    run.durationMs === undefined
      ? unknown("took")
      : known("took", formatDuration(run.durationMs)),
  ];
}

/**
 * What the node cost.
 *
 * Four rows, always, even when `usage` is absent altogether — that case is not
 * "this node was free", it is "no writer said", and the rows say so. There is
 * deliberately no total: adding a known input count to an unknown output count
 * would produce a number that looks measured and is not.
 */
export function usageRows(usage: Usage | undefined): DetailRow[] {
  return [
    usage?.model === undefined ? unknown("model") : known("model", usage.model),
    usage?.inputTokens === undefined
      ? unknown("input tokens")
      : known("input tokens", formatTokens(usage.inputTokens)),
    usage?.outputTokens === undefined
      ? unknown("output tokens")
      : known("output tokens", formatTokens(usage.outputTokens)),
    usage?.costUsd === undefined ? unknown("cost") : known("cost", formatCost(usage.costUsd)),
  ];
}

/** True when the trace said nothing at all about what this node cost. */
export function usageIsEmpty(usage: Usage | undefined): boolean {
  return (
    usage === undefined ||
    (usage.model === undefined &&
      usage.inputTokens === undefined &&
      usage.outputTokens === undefined &&
      usage.costUsd === undefined)
  );
}

/**
 * A fanned node, instance by instance — as far as the fold goes.
 *
 * `reduceRun` keeps counts, not rows: it knows three instances landed, not
 * which three or what each of them cost. The pop-over says so rather than
 * implying the breakdown is complete; the per-instance events are in the trace
 * file, where `instance` is on every one of them.
 */
export function instanceRows(counts: InstanceCounts): DetailRow[] {
  const out = counts.of - counts.done - counts.failed;
  return [
    known("done", String(counts.done)),
    known("failed", String(counts.failed)),
    known("still out", String(Math.max(out, 0))),
    known("fanned to", String(counts.of)),
  ];
}

/** A one-line summary of a fanned node, for the pop-over's heading. */
export function summariseInstances(counts: InstanceCounts): string {
  return `${counts.done + counts.failed} of ${counts.of} instances settled`;
}

/** Roughly what the note occupies on screen, which is all the placement needs. */
export const NOTE_W = 320;
export const NOTE_H = 380;
export const NOTE_GAP = 14;

export type NoteSide = "right" | "left" | "top" | "bottom";
export type NoteAlign = "start" | "center" | "end";

/**
 * Which side of the node the note goes, and how it lines up.
 *
 * Beside the node if it fits, because that is where a note pinned to a drawing
 * belongs; below or above it when the canvas is too narrow for either side.
 * Everything is measured against the pane in screen pixels, so a node hard
 * against the right edge gets its note on the left rather than half a note
 * off-screen.
 *
 * Placement reads the viewport; it never writes one. The note moves around the
 * node — the node does not move to make room for the note.
 */
export function placeNote(
  box: { x: number; y: number; w: number; h: number },
  view: { tx: number; ty: number; zoom: number; paneW: number; paneH: number },
): { side: NoteSide; align: NoteAlign } {
  const left = box.x * view.zoom + view.tx;
  const top = box.y * view.zoom + view.ty;
  const right = left + box.w * view.zoom;
  const bottom = top + box.h * view.zoom;

  const align: NoteAlign =
    top + NOTE_H <= view.paneH ? "start" : bottom - NOTE_H >= 0 ? "end" : "center";

  if (right + NOTE_GAP + NOTE_W <= view.paneW) return { side: "right", align };
  if (left - NOTE_GAP - NOTE_W >= 0) return { side: "left", align };
  return {
    side: bottom + NOTE_GAP + NOTE_H <= view.paneH ? "bottom" : "top",
    align: "center",
  };
}
