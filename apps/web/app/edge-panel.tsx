"use client";
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { Model } from "../lib/graph-model";
import {
  becomesStart,
  deleteEdge,
  edgeAt,
  edgesOf,
  retargetEdge,
  unfedAfterRemoving,
  type EdgeRef,
  type FieldChoice,
  type GestureResult,
} from "../lib/edge-gestures";
import { applyRepair, describeRepair, findingsFor } from "../lib/inspector";

/**
 * The edge half of the canvas's controls, outside JointJS: the field chooser a
 * drawn link opens, the selected edge's panel, a step's list of edges, and the
 * short notes the canvas gives back (a gesture done, a gesture refused, why a
 * dragged step went back). Every control here is a real, labelled element, so
 * everything the pointer can do to an edge can also be done from the keyboard.
 */

const arrow = (e: EdgeRef) => `${e.from} → ${e.to}`;

/**
 * Which field a new edge carries. Opened when a link is dropped on a step (or
 * "wire to" is used in the inspector) and the source produces more than one
 * field. A field that cannot be carried here stays listed, disabled, with the
 * reason beside it, so the list says why the choice is narrower than `out`.
 */
export function EdgeChooser({
  from,
  to,
  choices,
  onChoose,
  onCancel,
}: {
  from: string;
  to: string;
  choices: readonly FieldChoice[];
  onChoose: (field: string) => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  return (
    <div
      ref={box}
      className="edge-chooser"
      role="dialog"
      aria-labelledby="edge-chooser-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <p id="edge-chooser-title">
        wire <b>{from}</b> → <b>{to}</b>: which field does it carry?
      </p>
      <ul>
        {choices.map((c) => (
          <li key={c.field}>
            <button
              type="button"
              disabled={c.refusal !== undefined}
              aria-describedby={`edge-choice-${c.field}`}
              onClick={() => onChoose(c.field)}
            >
              {c.field}
              <span className="type">: {c.type}</span>
            </button>
            <span id={`edge-choice-${c.field}`} className={c.refusal ? "note refused" : "note"}>
              {c.refusal ?? (c.read ? `${to} reads this` : `adds ${c.field} to ${to}'s in`)}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="ghost" onClick={onCancel}>
        cancel
      </button>
    </div>
  );
}

/** What the last gesture did, or why it was refused. Announced, and dismissible. */
export function CanvasNotice({
  notice,
  onDismiss,
}: {
  notice: { tone: "done" | "refused"; text: string } | undefined;
  onDismiss: () => void;
}) {
  return (
    <div className="canvas-notice-host" role="status" aria-live="polite">
      {notice && (
        <p className={`canvas-notice ${notice.tone}`}>
          <span>
            {notice.tone === "refused" ? "not done: " : ""}
            {notice.text}
          </span>
          <button type="button" aria-label="dismiss this note" onClick={onDismiss}>
            ×
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Shown the first time a step is dragged: the step went back on purpose. Said
 * once, because the second time the reader already knows.
 */
export function DragNote({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="drag-note" role="note" aria-label="why the step went back">
      <p>
        A step's place is worked out from what it depends on, so it cannot be put somewhere by
        hand. To move one, change what it depends on: drag from the dot under a step onto another
        step to wire them, or click an edge to delete it or drag either end somewhere else.
      </p>
      <button type="button" className="ghost" onClick={onDismiss}>
        understood
      </button>
    </div>
  );
}

/**
 * The selected edge, in the inspector: what it carries, whether the linter
 * thinks it is fake, and the three things that can be done to it. Delete is
 * also the Delete and Backspace keys while the edge is selected.
 */
export function EdgePanel({
  model,
  edge,
  onGesture,
  onEdit,
  onBack,
  focusToken,
}: {
  model: Model;
  edge: EdgeRef;
  onGesture: (result: GestureResult) => void;
  onEdit: (source: string) => void;
  onBack: () => void;
  focusToken: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusToken > 0) heading.current?.focus();
  }, [focusToken]);
  const [failure, setFailure] = useState<string>();

  const spec = model.base.spec;
  // The editor only selects edges the spec as written has; this is the type's guard.
  const written = edgeAt(spec, edge);
  if (!written) return null;

  const fake = model.result.findings.find(
    (f) =>
      f.rule === "FAKE_EDGE" && f.phase === "raw" && f.edge?.from === edge.from && f.edge.to === edge.to,
  );
  const repair = fake
    ? findingsFor(model.base, model.result.findings, edge.to).find((f) => f.finding === fake)?.repair
    : undefined;
  const repairIsDrop = repair?.repair.kind === "drop";
  const unfed = unfedAfterRemoving(spec, edge);
  const start = becomesStart(spec, edge);
  const others = spec.nodes.map((n) => n.id);

  return (
    <section className="edge-panel" aria-labelledby="edge-panel-title">
      <h3 id="edge-panel-title" ref={heading} tabIndex={-1}>
        edge {arrow(edge)}
      </h3>
      <p className="edge-carries">
        {written.carries.length === 0 ? "carries nothing" : `carries ${written.carries.join(", ")}`}
      </p>

      {fake && (
        <div className="edge-fake">
          <p>
            <span className="rule">FAKE_EDGE</span> {fake.message}
          </p>
          <p>
            {repairIsDrop || !repair
              ? "Deleting it is the linter's repair, made by hand."
              : `Deleting it is half of the linter's repair, which is to ${describeRepair(repair)}.`}
          </p>
          {repair && !repairIsDrop && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                const result = applyRepair(model.base, repair);
                if (result.ok) {
                  setFailure(undefined);
                  onEdit(result.source);
                } else setFailure(result.errors.join("; "));
              }}
            >
              apply the linter's repair
            </button>
          )}
        </div>
      )}

      {(unfed.length > 0 || start) && (
        <p className="field-hint">
          {start
            ? `Without it ${edge.to} has no inbound edges and becomes a starting step: what it reads becomes what the workflow is given.`
            : `Without it nothing feeds ${edge.to} ${unfed.join(", ")}. Its in stays as it is, and the linter will say so (MISSING_INPUT).`}
        </p>
      )}

      <div className="edge-actions">
        <button
          type="button"
          className={fake ? "" : "danger"}
          aria-keyshortcuts="Delete Backspace"
          onClick={() => onGesture(deleteEdge(spec, edge))}
        >
          {fake ? "delete this fake edge" : "delete this edge"}
        </button>
      </div>

      <label className="edge-move">
        <span>move the start to</span>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value !== "") onGesture(retargetEdge(spec, edge, "from", e.target.value));
          }}
        >
          <option value="">{edge.from}</option>
          {others
            .filter((id) => id !== edge.from)
            .map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
        </select>
      </label>
      <label className="edge-move">
        <span>move the end to</span>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value !== "") onGesture(retargetEdge(spec, edge, "to", e.target.value));
          }}
        >
          <option value="">{edge.to}</option>
          {others
            .filter((id) => id !== edge.to)
            .map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
        </select>
      </label>

      {failure && (
        <p className="field-error" role="alert">
          {failure}
        </p>
      )}

      <button type="button" className="ghost edge-back" onClick={onBack}>
        back to the step
      </button>
    </section>
  );
}

/**
 * A step's edges, listed in the inspector: the keyboard's way to reach an
 * edge (select it, delete it) and to draw a new one ("wire to").
 */
export function StepEdges({
  model,
  nodeId,
  onSelectEdge,
  onGesture,
  onConnect,
}: {
  model: Model;
  nodeId: string;
  onSelectEdge: (edge: EdgeRef) => void;
  onGesture: (result: GestureResult) => void;
  onConnect: (from: string, to: string) => void;
}) {
  const spec = model.base.spec;
  const { inbound, outbound } = edgesOf(spec, nodeId);
  const fake = new Set(
    model.result.findings
      .filter((f) => f.rule === "FAKE_EDGE" && f.phase === "raw" && f.edge)
      .map((f) => arrow(f.edge!)),
  );

  const row = (e: EdgeRef & { carries: readonly string[] }) => (
    <li key={arrow(e)}>
      <button type="button" className="ghost edge-pick" onClick={() => onSelectEdge(e)}>
        {arrow(e)}
      </button>
      <span className={fake.has(arrow(e)) ? "carries fake" : "carries"}>
        {e.carries.length === 0 ? "carries nothing" : e.carries.join(", ")}
      </span>
      <button
        type="button"
        className="ghost"
        aria-label={`delete edge ${arrow(e)}`}
        onClick={() => onGesture(deleteEdge(spec, e))}
      >
        delete
      </button>
    </li>
  );

  return (
    <section className="inspector-edges" aria-label="edges of this step">
      <h3>edges</h3>
      {inbound.length + outbound.length === 0 ? (
        <p className="clean">no edges in or out</p>
      ) : (
        <ul>
          {inbound.map(row)}
          {outbound.map(row)}
        </ul>
      )}
      <label className="edge-move">
        <span>wire to</span>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value !== "") onConnect(nodeId, e.target.value);
          }}
        >
          <option value="">a step…</option>
          {spec.nodes
            .filter((n) => n.id !== nodeId)
            .map((n) => (
              <option key={n.id} value={n.id}>
                {n.id}
              </option>
            ))}
        </select>
      </label>
    </section>
  );
}
