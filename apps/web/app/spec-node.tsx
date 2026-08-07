"use client";
// SPDX-License-Identifier: Apache-2.0

import {
  Handle,
  NodeToolbar,
  Position,
  useStore,
  type Align,
  type NodeProps,
} from "@xyflow/react";
import { TAIL_CAP, type NodeRunState } from "@ccgrapher/trace";
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
 * note is a portal into React Flow's renderer, outside the zoom transform, so
 * opening one cannot nudge the drawing by a pixel: it is the same invariant the
 * tint obeys, held one step further out.
 */
export function SpecNode({ data, id, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps) {
  const d = data as {
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
  };

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
  // down does. Capture phase, because React Flow starts a pan on pointerdown and
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
    <div
      className={`spec-node style-${d.style}${d.worktree ? " worktree" : ""}${
        hasProblem ? " flagged" : ""
      }${run ? ` run-${status}` : ""}${open ? " opened" : ""}`}
      style={{ background: KIND_TINT[d.kind] ?? "#fff", borderColor: INK }}
      title={[...d.problems, ...runTitle(run)].join("\n") || undefined}
      data-run-status={run ? status : undefined}
    >
      <Handle type="target" position={Position.Top} />
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

      {openable && open && (
        <RunDetail
          nodeId={id}
          heading={d.label ?? id}
          kind={d.kind}
          run={run}
          // The spec side survives even when no overlay has run over this node,
          // so the note can still say what it declares.
          declared={d.capability?.declared ?? d.uses ?? []}
          invoked={d.capability?.invoked ?? run.invoked ?? []}
          box={{ x: positionAbsoluteX, y: positionAbsoluteY, w: width ?? 0, h: height ?? 0 }}
          noteRef={note}
          onClose={close}
        />
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
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

/**
 * The note itself.
 *
 * Mounted only while it is open, so a canvas at rest subscribes to nothing and
 * a pan does not re-render seven closed pop-overs.
 */
function RunDetail({
  nodeId,
  heading,
  kind,
  run,
  declared,
  invoked,
  box,
  noteRef,
  onClose,
}: {
  nodeId: string;
  heading: string;
  kind: string;
  run: NodeRunState;
  declared: readonly string[];
  invoked: readonly string[];
  box: { x: number; y: number; w: number; h: number };
  noteRef: RefObject<HTMLDivElement | null>;
  onClose: (restoreFocus: boolean) => void;
}) {
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);

  const place = placement(box, { tx, ty, zoom, paneW, paneH });

  useEffect(() => {
    noteRef.current?.focus({ preventScroll: true });
    // Focus goes to the note once, when it opens. Re-running this on a pan would
    // steal focus back every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failed = run.status === "failed";
  const gate = kind === "gate";
  const truncated = run.tail.length >= TAIL_CAP;

  return (
    <NodeToolbar
      nodeId={nodeId}
      isVisible
      position={place.position}
      align={place.align}
      offset={NOTE_GAP}
      // The toolbar portal is a sibling of the viewport, which sits at z-index 2.
      // Without this the note would be drawn *underneath* the nodes unless the
      // node happened to be selected, which is a coincidence, not a guarantee.
      style={{ zIndex: 10 }}
    >
      <div
        ref={noteRef}
        className="run-note nowheel nopan nodrag"
        role="dialog"
        aria-label={`what ${heading} did`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // React Flow reads Escape on the node as "deselect". One key, one
          // meaning: while this is open it closes this.
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
      </div>
    </NodeToolbar>
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

/**
 * Which side of the node the note goes, and how it lines up.
 *
 * Beside the node if it fits, because that is where a note pinned to a drawing
 * belongs; below it when the canvas is too narrow for either side. Everything is
 * measured against the pane, so a node against the right edge gets its note on
 * the left instead of half a note off-screen.
 */
export function placement(
  box: { x: number; y: number; w: number; h: number },
  view: { tx: number; ty: number; zoom: number; paneW: number; paneH: number },
): { position: Position; align: Align } {
  const left = box.x * view.zoom + view.tx;
  const top = box.y * view.zoom + view.ty;
  const right = left + box.w * view.zoom;
  const bottom = top + box.h * view.zoom;

  const align: Align =
    top + NOTE_H <= view.paneH ? "start" : bottom - NOTE_H >= 0 ? "end" : "center";

  if (right + NOTE_GAP + NOTE_W <= view.paneW) return { position: Position.Right, align };
  if (left - NOTE_GAP - NOTE_W >= 0) return { position: Position.Left, align };
  return {
    position: bottom + NOTE_GAP + NOTE_H <= view.paneH ? Position.Bottom : Position.Top,
    align: "center",
  };
}
