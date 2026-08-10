"use client";
// SPDX-License-Identifier: Apache-2.0

import { HTMLHost, useCellId, usePaper } from "@joint/react";
import { TAIL_CAP, type NodeRunState } from "@ccgrapher/trace";
import {
  createPortal,
} from "react-dom";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { INK, KIND_TINT } from "../lib/graph-model";
import {
  instanceRows,
  summariseInstances,
  timingRows,
  usageIsEmpty,
  usageRows,
  type DetailRow,
} from "../lib/run-detail";
import { declaredRows, invokedRows, type CapabilityState } from "../lib/capability";

/**
 * Same visual vocabulary as the SVG renderer: agent nodes get a sketchy border,
 * code-only nodes sharp corners to say "this costs nothing", the human gate a
 * dashed one, a fanOut node a stacked card and an ×N badge.
 *
 * Run status is a tint on top of that drawing and nothing more. It changes no
 * dimension and no position — see `lib/overlay.ts`.
 *
 * Clicking a node that the run has said something about pins a note to it. The
 * note is a portal to `document.body`, outside JointJS's SVG entirely, so opening
 * one cannot nudge the drawing by a pixel: it is the same invariant the tint
 * obeys, held one step further out.
 */
export interface SpecNodeData {
  label?: string;
  lines: string[];
  kind: string;
  style: "agent" | "code" | "human";
  badge: string | null;
  worktree: boolean;
  problems: string[];
  uses?: readonly string[];
  run?: NodeRunState;
  capability?: CapabilityState;
  className?: string;
}

export function SpecNode(d: SpecNodeData) {
  const id = useCellId();
  const { paper } = usePaper();

  const hasProblem = d.problems.length > 0;
  const run = d.run;
  const status = run?.status ?? "pending";

  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const pressedAt = useRef<{ x: number; y: number }>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  // Anywhere else on the canvas dismisses the note, the way putting a paper one
  // down does. Capture phase, because JointJS starts a pan on pointerdown and
  // this needs to have decided before it does.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (target && (note.current?.contains(target) || trigger.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  // A node the run has not mentioned has nothing to show, so it gets no
  // affordance at all rather than a note that says nothing.
  const openable = run !== undefined;

  // A fanned node in flight says how far along it is; at rest it says how wide
  // it fans. Same corner, same size, so nothing jumps when the run reaches it.
  const counts = run?.instances;
  const badge =
    counts && (status === "running" || status === "partial")
      ? `${counts.done + counts.failed}/${counts.of}`
      : d.badge;

  return (
    <HTMLHost
      useModelGeometry
      className={`spec-node style-${d.style}${d.worktree ? " worktree" : ""}${
        hasProblem ? " flagged" : ""
      }${run ? ` run-${status}` : ""}${open ? " opened" : ""}${d.className ? ` ${d.className}` : ""}`}
      style={{ background: KIND_TINT[d.kind] ?? "#fff", borderColor: INK }}
      title={[...d.problems, ...runTitle(run)].join("\n") || undefined}
      data-run-status={run ? status : undefined}
    >
      {badge && <span className="badge">{badge}</span>}
      <span className={`icon icon-${d.kind}`} aria-hidden />
      <span className="label">
        {d.lines.map((line, i) => (
          <span key={i} className="line">
            {line}
          </span>
        ))}
      </span>
      {run && status !== "pending" && <RunMark status={status} />}
      {hasProblem && <span className="warn" aria-label="lint finding" />}

      {openable && (
        <button
          ref={trigger}
          type="button"
          className="run-open nodrag"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`what ${d.label ?? id} did — ${status}`}
          onPointerDown={(event) => {
            pressedAt.current = { x: event.clientX, y: event.clientY };
          }}
          onClick={(event) => {
            // `detail === 0` is a keyboard activation, which has no travel to
            // measure. A pointer that moved was dragging the node, and a drag
            // should not leave a note open behind it.
            const from = pressedAt.current;
            const dragged =
              event.detail > 0 &&
              from !== null &&
              Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4;
            if (dragged) return;
            if (open) close(false);
            else setOpen(true);
          }}
        />
      )}

      {openable && open && paper && (
        <RunDetail
          nodeId={String(id)}
          heading={d.label ?? String(id)}
          kind={d.kind}
          run={run}
          // The spec side survives even when no overlay has run over this node,
          // so the note can still say what it declares.
          declared={d.capability?.declared ?? d.uses ?? []}
          invoked={d.capability?.invoked ?? run.invoked ?? []}
          paper={paper}
          noteRef={note}
          onClose={close}
        />
      )}
    </HTMLHost>
  );
}

/**
 * The status glyph.
 *
 * Every status carries a shape as well as a colour, and `waiting` carries a word,
 * because the difference that matters most here — nothing is happening, someone
 * is being asked — is exactly the one a colour alone would not make.
 */
function RunMark({ status }: { status: NodeRunState["status"] }) {
  const label = MARK_LABEL[status];
  if (!label) return null;
  return (
    <span className={`run-mark mark-${status}`} role="img" aria-label={label}>
      <span aria-hidden>{MARK_GLYPH[status]}</span>
      {status === "waiting" && <em>waiting on a human</em>}
    </span>
  );
}

const MARK_LABEL: Partial<Record<NodeRunState["status"], string>> = {
  running: "running",
  waiting: "waiting on a human",
  done: "done",
  failed: "failed",
  partial: "some instances still out",
};

const MARK_GLYPH: Partial<Record<NodeRunState["status"], string>> = {
  running: "•",
  waiting: "?",
  done: "✓",
  failed: "✕",
  partial: "•",
};

/** A first read of what the run said, on hover. The note below has all of it. */
function runTitle(run: NodeRunState | undefined): string[] {
  if (!run) return [];
  const lines = [`status: ${run.status}`];
  if (run.durationMs !== undefined) lines.push(`took ${run.durationMs} ms`);
  if (run.instances) {
    lines.push(
      `instances: ${run.instances.done} done, ${run.instances.failed} failed of ${run.instances.of}`,
    );
  }
  if (run.error) lines.push(run.error);
  const tail = run.tail.at(-1);
  if (tail) lines.push(`… ${tail}`);
  return lines;
}

/** Roughly what the note occupies on screen, which is all the flip needs. */
const NOTE_W = 320;
const NOTE_H = 380;
const NOTE_GAP = 14;

/** Where a node currently sits in client (viewport) pixels — pan/zoom already applied. */
function clientBox(
  paper: NonNullable<ReturnType<typeof usePaper>["paper"]>,
  nodeId: string,
): { x: number; y: number; w: number; h: number } | undefined {
  const cell = paper.model.getCell(nodeId);
  if (!cell || !("position" in cell.attributes)) return undefined;
  const bbox = cell.getBBox();
  const topLeft = paper.localToClientPoint(bbox.x, bbox.y);
  const bottomRight = paper.localToClientPoint(bbox.x + bbox.width, bbox.y + bbox.height);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: bottomRight.x - topLeft.x,
    h: bottomRight.y - topLeft.y,
  };
}

/**
 * The note itself.
 *
 * Mounted only while it is open, so a canvas at rest subscribes to nothing and
 * a pan does not re-render seven closed pop-overs. Portalled straight to
 * `document.body` and positioned in client pixels via `paper.localToClientPoint`,
 * which already folds in the paper's current pan and zoom — no transform math
 * duplicated here. Re-measured on the paper's own `scale`/`translate` events so
 * the note tracks a pan or zoom while it is open, the same way the old
 * NodeToolbar portal did by living outside React Flow's transformed viewport.
 */
function RunDetail({
  nodeId,
  heading,
  kind,
  run,
  declared,
  invoked,
  paper,
  noteRef,
  onClose,
}: {
  nodeId: string;
  heading: string;
  kind: string;
  run: NodeRunState;
  declared: readonly string[];
  invoked: readonly string[];
  paper: NonNullable<ReturnType<typeof usePaper>["paper"]>;
  noteRef: RefObject<HTMLDivElement | null>;
  onClose: (restoreFocus: boolean) => void;
}) {
  const [box, setBox] = useState(() => clientBox(paper, nodeId));

  useEffect(() => {
    const recompute = () => setBox(clientBox(paper, nodeId));
    recompute();
    paper.on("scale", recompute);
    paper.on("translate", recompute);
    return () => {
      paper.off("scale", recompute);
      paper.off("translate", recompute);
    };
  }, [paper, nodeId]);

  useEffect(() => {
    noteRef.current?.focus({ preventScroll: true });
    // Focus goes to the note once, when it opens. Re-running this on a pan would
    // steal focus back every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!box) return null;

  const place = placement(box, { paneW: window.innerWidth, paneH: window.innerHeight });

  const failed = run.status === "failed";
  const gate = kind === "gate";
  const truncated = run.tail.length >= TAIL_CAP;

  return createPortal(
    <div
      ref={noteRef}
      className="run-note nowheel nopan nodrag"
      role="dialog"
      aria-label={`what ${heading} did`}
      tabIndex={-1}
      style={{
        position: "fixed",
        zIndex: 10,
        ...place.style,
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose(true);
      }}
    >
      <header>
        <h2>{heading}</h2>
        <button type="button" className="close" aria-label="close" onClick={() => onClose(true)}>
          ×
        </button>
      </header>

      <Rows rows={timingRows(run)} />

      {run.instances && (
        <Section title="instances" note={summariseInstances(run.instances)}>
          <Rows rows={instanceRows(run.instances)} />
          <p className="aside">
            the fold keeps counts; the per-instance rows are in the trace file
          </p>
        </Section>
      )}

      <Section title="what it cost">
        {usageIsEmpty(run.usage) && (
          <p className="aside">nothing reported usage for this node — this is not a zero</p>
        )}
        <Rows rows={usageRows(run.usage)} />
      </Section>

      {/*
       * Two lists, not one merged one. The spec's claim and the run's report
       * are separate facts, and the interesting cases are exactly the ones a
       * merge would hide: a capability declared and never heard from, and one
       * used that nothing ever declared.
       */}
      <Section title="capabilities declared">
        {declared.length === 0 ? (
          <p className="aside">this node declares no capabilities</p>
        ) : (
          <div className="caps">
            <Rows rows={declaredRows(declared, invoked)} />
          </div>
        )}
      </Section>

      <Section title="capabilities used">
        {invoked.length === 0 ? (
          <p className="aside">nothing reported capability use — this is not a zero</p>
        ) : (
          <div className="caps">
            <Rows rows={invokedRows(declared, invoked)} />
          </div>
        )}
      </Section>

      {(failed || run.error !== undefined) && (
        <Section title={gate ? "the reviewer said" : "error"}>
          {run.error === undefined ? (
            // A rejection with no note, or a failure whose message never
            // reached the trace. Saying so beats an empty box that reads as
            // "no problem here".
            <p className="aside">
              {gate ? "rejected, with no reason given" : "no message was recorded"}
            </p>
          ) : (
            <pre className="error-text">{run.error}</pre>
          )}
        </Section>
      )}

      {run.gatePayload !== undefined && (
        <Section title="what the gate asked about">
          <pre className="payload">{stringify(run.gatePayload)}</pre>
        </Section>
      )}

      <Section title="output">
        {run.tail.length === 0 ? (
          <p className="aside">no output lines were recorded</p>
        ) : (
          <>
            {truncated && <p className="aside">earlier lines are in the trace file</p>}
            <pre className="tail">{run.tail.join("\n")}</pre>
          </>
        )}
      </Section>
    </div>,
    document.body,
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3>
        {title}
        {note && <em>{note}</em>}
      </h3>
      {children}
    </section>
  );
}

/**
 * A row per value, always.
 *
 * `recorded: false` is drawn differently and is never drawn as `0`, because a
 * measured zero and an unmeasured one are opposite facts.
 */
function Rows({ rows }: { rows: readonly DetailRow[] }) {
  return (
    <dl>
      {rows.map((row) => (
        <div key={row.label} className={row.recorded ? "" : "absent"}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function stringify(payload: unknown): string {
  try {
    const text = JSON.stringify(payload, null, 2) ?? String(payload);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n… (see the trace file)` : text;
  } catch {
    return String(payload);
  }
}

/** A side and an alignment, expressed as the CSS this note is placed with. */
export type NotePosition = "top" | "right" | "bottom" | "left";
export type NoteAlign = "start" | "end" | "center";

/**
 * A `Position`-shaped constant with the same member names @xyflow/react's
 * `Position` enum had, so `run-detail.test.ts`'s assertions
 * (`toBe(Position.Right)` etc) survive the library swap verbatim — this is a
 * value swap, not a logic change.
 */
export const Position = { Top: "top", Right: "right", Bottom: "bottom", Left: "left" } as const;

/**
 * Which side of the node the note goes, and how it lines up.
 *
 * Beside the node if it fits, because that is where a note pinned to a drawing
 * belongs; below it when the canvas is too narrow for either side. Everything is
 * measured against the viewport, so a node against the right edge gets its note
 * on the left instead of half a note off-screen. Pure — the same decision as
 * before the JointJS migration, just fed a client-space box instead of a
 * model-space one pre-multiplied by hand.
 */
export function placement(
  box: { x: number; y: number; w: number; h: number },
  view: { paneW: number; paneH: number },
): { position: NotePosition; align: NoteAlign; style: Record<string, number | string> } {
  const { x: left, y: top, w, h } = box;
  const right = left + w;
  const bottom = top + h;

  const sideAlign: NoteAlign =
    top + NOTE_H <= view.paneH ? "start" : bottom - NOTE_H >= 0 ? "end" : "center";

  const position: NotePosition =
    right + NOTE_GAP + NOTE_W <= view.paneW
      ? "right"
      : left - NOTE_GAP - NOTE_W >= 0
        ? "left"
        : bottom + NOTE_GAP + NOTE_H <= view.paneH
          ? "bottom"
          : "top";

  // Falling through to above/below the node is always centred — only the
  // beside-the-node cases (right/left) use the top/bottom fit to decide.
  const align: NoteAlign = position === "bottom" || position === "top" ? "center" : sideAlign;

  const style: Record<string, number | string> = { width: NOTE_W };
  if (position === "right") style.left = right + NOTE_GAP;
  else if (position === "left") style.left = left - NOTE_GAP - NOTE_W;
  else style.left = Math.max(8, Math.min(left, view.paneW - NOTE_W - 8));

  if (position === "bottom") style.top = bottom + NOTE_GAP;
  else if (position === "top") style.top = Math.max(8, top - NOTE_GAP - NOTE_H);
  else if (align === "start") style.top = top;
  else if (align === "end") style.top = bottom - NOTE_H;
  else style.top = (top + bottom) / 2 - NOTE_H / 2;

  return { position, align, style };
}
