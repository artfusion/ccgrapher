"use client";
// SPDX-License-Identifier: Apache-2.0

import type { NodeSpec } from "@ccgrapher/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ModelState } from "../lib/graph-model";
import {
  applyRepair,
  describeRepair,
  editNode,
  findingsFor,
  fromNumberText,
  fromYaml,
  NODE_FIELDS,
  NULL,
  toYaml,
  UNSET,
  valueOf,
  type Field,
} from "../lib/inspector";

/**
 * The node inspector: the selected step's fields, edited in place.
 *
 * Every control here is generated from `NODE_FIELDS`, which is read off the
 * zod schema (see lib/inspector.ts for the table and its limits). Nothing in
 * this file knows that a node has a `model` or an `expects`; it knows how to
 * draw a select, a toggle, a number, chips, key/type rows, a group of those,
 * and a YAML fallback for anything else.
 *
 * The panel never holds a copy of the spec. Each committed value goes through
 * `editNode`, which validates it and returns either the new spec text or the
 * reason it was refused. A new text goes to `onEdit`, the same place a typed
 * edit lands, so the text area, the picture and the lint report all follow
 * from it; a refusal stays next to the control that caused it.
 *
 * Text-like controls commit on Enter or when focus leaves them, so one change
 * is one undoable edit rather than one per keystroke. Escape puts the draft
 * back. Selects, toggles and chip removal commit at once.
 */
export function Inspector({
  model,
  selectedId,
  onSelect,
  onEdit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  focusToken,
}: {
  model: ModelState;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onEdit: (source: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Changes whenever focus should move to the panel: a step was picked on the canvas. */
  focusToken: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const picker = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (focusToken > 0) heading.current?.focus();
  }, [focusToken]);

  // A refusal is pinned to the value it was a refusal *of*. When the value
  // changes underneath it (an undo, a typed edit), the control resets and the
  // stale message is simply not shown, rather than needing to be cleared.
  const [errors, setErrors] = useState<Record<string, { of: string; messages: readonly string[] }>>(
    {},
  );

  const nodes = model.ok ? model.base.spec.nodes : [];
  const node = nodes.find((n) => n.id === selectedId);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !typing && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) onRedo();
      else onUndo();
    } else if (mod && !typing && event.key.toLowerCase() === "y") {
      event.preventDefault();
      onRedo();
    } else if (event.key === "Escape" && !event.defaultPrevented && node) {
      onSelect(undefined);
      picker.current?.focus();
    }
  };

  return (
    <aside className="pane inspector" aria-labelledby="inspector-title" onKeyDown={onKeyDown}>
      <div className="inspector-head">
        <h2 id="inspector-title" ref={heading} tabIndex={-1}>
          {node ? node.label : "step"}
        </h2>
        <div className="inspector-history">
          <button
            type="button"
            className="ghost"
            onClick={onUndo}
            disabled={!canUndo}
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            undo
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onRedo}
            disabled={!canRedo}
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
          >
            redo
          </button>
        </div>
      </div>

      <label className="inspector-picker">
        <span>inspect</span>
        <select
          ref={picker}
          value={node ? node.id : ""}
          disabled={!model.ok}
          onChange={(e) => onSelect(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">no step selected</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id}
            </option>
          ))}
        </select>
      </label>

      {!model.ok ? (
        <p className="inspector-note bad">
          The spec does not parse, so there is nothing to edit here until the text is fixed.
        </p>
      ) : !node ? (
        <p className="inspector-note">
          Select a step on the canvas, or pick one above. Its fields are the spec: change one and
          the text, the picture and the findings follow.
        </p>
      ) : (
        <>
          <Findings
            key={node.id}
            nodeId={node.id}
            model={model}
            onApply={(repairSource) => onEdit(repairSource)}
          />
          <div className="inspector-fields">
            {NODE_FIELDS.map((field) => {
              const value = valueOf(node, field.key);
              const shown = JSON.stringify(value) ?? "";
              const errorKey = `${node.id}:${field.key}`;
              const error = errors[errorKey];
              const commit = (next: unknown) => {
                const result = editNode(model.base.spec, node.id, field.key, next);
                if (result.ok) {
                  setErrors((all) => {
                    const rest = { ...all };
                    delete rest[errorKey];
                    return rest;
                  });
                  onEdit(result.source);
                } else {
                  setErrors((all) => ({ ...all, [errorKey]: { of: shown, messages: result.errors } }));
                }
              };
              const refuse = (message: string) =>
                setErrors((all) => ({ ...all, [errorKey]: { of: shown, messages: [message] } }));
              return (
                <FieldRow
                  // Remounts the control when the value changes from outside, so
                  // a draft never outlives the value it was a draft of.
                  key={`${node.id}:${field.key}:${shown}`}
                  field={field}
                  node={node}
                  value={value}
                  errors={error && error.of === shown ? error.messages : []}
                  onCommit={commit}
                  onRefuse={refuse}
                />
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}

function Findings({
  nodeId,
  model,
  onApply,
}: {
  nodeId: string;
  model: Extract<ModelState, { ok: true }>;
  onApply: (source: string) => void;
}) {
  const items = findingsFor(model.base, model.result.findings, nodeId);
  const [failure, setFailure] = useState<string>();

  return (
    <section className="inspector-findings" aria-label="lint findings for this step">
      {items.length === 0 ? (
        <p className="clean">no findings on this step</p>
      ) : (
        <ul>
          {items.map(({ finding, repair }, i) => (
            // Prefixed: a bare `error` class picks up the parse-error block's padding.
            <li key={i} className={`severity-${finding.severity}`}>
              <span className="rule">{finding.rule}</span>
              <span className="message">
                {finding.message}
                {finding.phase === "repaired" && <em> (after repair)</em>}
              </span>
              {repair && (
                <span className="repair">
                  <span className="repair-text">
                    repair: {describeRepair(repair)}. <em>{repair.repair.why}</em>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const result = applyRepair(model.base, repair);
                      if (result.ok) {
                        setFailure(undefined);
                        onApply(result.source);
                      } else {
                        setFailure(result.errors.join("; "));
                      }
                    }}
                  >
                    apply
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p className="field-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

function FieldRow({
  field,
  node,
  value,
  errors,
  onCommit,
  onRefuse,
}: {
  field: Field;
  node: NodeSpec;
  value: unknown;
  errors: readonly string[];
  onCommit: (value: unknown) => void;
  onRefuse: (message: string) => void;
}) {
  const id = `inspect-${node.id}-${field.key}`;
  const hintId = field.hint ? `${id}-hint` : undefined;
  const errorId = errors.length > 0 ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const a11y = { id, "aria-describedby": describedBy, "aria-invalid": errors.length > 0 };

  // A group is a fieldset; every other control has one labelled input.
  const grouped = field.control.type === "group" || field.control.type === "chips" || field.control.type === "record";

  const body = (
    <>
      <Control field={field} value={value} a11y={a11y} onCommit={onCommit} onRefuse={onRefuse} />
      {field.hint && (
        <p id={hintId} className="field-hint">
          {field.hint}
        </p>
      )}
      {errors.length > 0 && (
        <p id={errorId} className="field-error" role="alert">
          {errors.join("; ")}
        </p>
      )}
    </>
  );

  return grouped ? (
    <fieldset className={`field field-${field.control.type}`} aria-describedby={describedBy}>
      <legend>{field.key}</legend>
      {body}
    </fieldset>
  ) : (
    <div className={`field field-${field.control.type}`}>
      <label htmlFor={id}>{field.key}</label>
      {body}
    </div>
  );
}

interface A11y {
  readonly id: string;
  readonly "aria-describedby": string | undefined;
  readonly "aria-invalid": boolean;
}

function Control({
  field,
  value,
  a11y,
  onCommit,
  onRefuse,
}: {
  field: Field;
  value: unknown;
  a11y: A11y;
  onCommit: (value: unknown) => void;
  onRefuse: (message: string) => void;
}): ReactNode {
  const { control } = field;

  if (field.readOnly) {
    return (
      <output {...a11y} className="field-readonly">
        {String(value ?? "")}
      </output>
    );
  }

  switch (control.type) {
    case "text":
      return (
        <DraftInput
          {...a11y}
          initial={typeof value === "string" ? value : ""}
          onCommit={(text) => onCommit(text === "" && field.optional ? undefined : text)}
        />
      );

    case "number":
      return (
        <DraftInput
          {...a11y}
          inputMode={control.integer ? "numeric" : "decimal"}
          initial={value === undefined ? "" : String(value)}
          placeholder={field.optional ? "unset" : undefined}
          onCommit={(text) => onCommit(fromNumberText(text))}
        />
      );

    case "select": {
      const current = value === undefined ? UNSET : value === null ? NULL : String(value);
      return (
        <select
          {...a11y}
          value={current}
          onChange={(e) => {
            const v = e.target.value;
            onCommit(v === UNSET ? undefined : v === NULL ? null : v);
          }}
        >
          {field.optional && <option value={UNSET}>unset</option>}
          {control.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {field.nullable && <option value={NULL}>null</option>}
        </select>
      );
    }

    case "toggle":
      return (
        <input
          {...a11y}
          type="checkbox"
          checked={value === true}
          // Off is written as absent when absent is allowed: the two mean the
          // same thing to every rule, and the shorter spec is the honest one.
          onChange={(e) => onCommit(e.target.checked ? true : field.optional ? undefined : false)}
        />
      );

    case "chips":
      return (
        <Chips
          a11y={a11y}
          label={field.key}
          items={Array.isArray(value) ? value.map(String) : []}
          onChange={(items) => onCommit(items.length === 0 && field.optional ? undefined : items)}
        />
      );

    case "record":
      return (
        <Rows
          a11y={a11y}
          label={field.key}
          entries={value && typeof value === "object" ? Object.entries(value as Record<string, string>) : []}
          onChange={(entries) => onCommit(Object.fromEntries(entries))}
          onRefuse={onRefuse}
        />
      );

    case "group": {
      const current = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
      return (
        <div className="group-fields">
          {control.fields.map((sub) => {
            const subId = `${a11y.id}-${sub.key}`;
            return (
              <div key={sub.key} className="field field-sub">
                <label htmlFor={subId}>{sub.key}</label>
                <Control
                  field={sub}
                  value={current?.[sub.key]}
                  a11y={{ ...a11y, id: subId }}
                  onCommit={(next) => {
                    const merged: Record<string, unknown> = { ...current, [sub.key]: next };
                    if (next === undefined) delete merged[sub.key];
                    onCommit(Object.keys(merged).length === 0 && field.optional ? undefined : merged);
                  }}
                  onRefuse={onRefuse}
                />
              </div>
            );
          })}
          {current && field.optional && (
            <button type="button" className="ghost small" onClick={() => onCommit(undefined)}>
              remove {field.key}
            </button>
          )}
        </div>
      );
    }

    case "yaml":
      return (
        <DraftInput
          {...a11y}
          multiline
          initial={toYaml(value)}
          onCommit={(text) => {
            const parsed = fromYaml(text);
            if (parsed.ok) onCommit(parsed.value);
            else onRefuse(parsed.error);
          }}
        />
      );
  }
}

/**
 * A text field that holds a draft and commits it on Enter or blur. Escape
 * restores the committed value and is swallowed, so it does not also close
 * the panel. A multiline one commits on blur or Ctrl/Cmd+Enter.
 */
function DraftInput({
  initial,
  onCommit,
  multiline = false,
  ...rest
}: A11y & {
  initial: string;
  onCommit: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
  inputMode?: "numeric" | "decimal";
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    if (draft !== initial) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape" && draft !== initial) {
      event.preventDefault();
      setDraft(initial);
    } else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  };
  return multiline ? (
    <textarea
      {...rest}
      spellCheck={false}
      rows={Math.min(8, Math.max(2, draft.split("\n").length))}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  ) : (
    <input
      {...rest}
      type="text"
      spellCheck={false}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

/** A string list: each entry a chip with its own remove button, and one input to add another. */
function Chips({
  a11y,
  label,
  items,
  onChange,
}: {
  a11y: A11y;
  label: string;
  items: readonly string[];
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const entry = draft.trim();
    if (entry === "") return;
    onChange([...items, entry]);
  };
  return (
    <div className="chips">
      {items.length > 0 && (
        <ul>
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="chip">
              <span>{item}</span>
              <button
                type="button"
                aria-label={`remove ${item} from ${label}`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chip-add">
        <input
          {...a11y}
          type="text"
          spellCheck={false}
          aria-label={`add to ${label}`}
          placeholder="add…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="ghost small" onClick={add} disabled={draft.trim() === ""}>
          add
        </button>
      </div>
    </div>
  );
}

/** A field map: one row per field, a name and a type, plus a row to add one. */
function Rows({
  a11y,
  label,
  entries,
  onChange,
  onRefuse,
}: {
  a11y: A11y;
  label: string;
  entries: readonly (readonly [string, string])[];
  onChange: (entries: [string, string][]) => void;
  onRefuse: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("string");
  const names = entries.map(([k]) => k);

  // A record cannot hold two fields of one name, so a rename onto an existing
  // name would quietly merge them. Refused here, in words, instead.
  const clash = (next: string, except?: number) =>
    names.some((existing, i) => existing === next && i !== except);

  const rename = (index: number, next: string) => {
    if (next === "") return onRefuse("a field needs a name");
    if (clash(next, index)) return onRefuse(`${label} already has a field called ${next}`);
    onChange(entries.map(([k, t], i) => (i === index ? [next, t] : [k, t])));
  };

  const add = () => {
    const next = name.trim();
    if (next === "") return onRefuse("a field needs a name");
    if (clash(next)) return onRefuse(`${label} already has a field called ${next}`);
    onChange([...entries.map(([k, t]) => [k, t] as [string, string]), [next, type.trim()]]);
  };

  return (
    <div className="rows" aria-describedby={a11y["aria-describedby"]}>
      {entries.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">field</th>
              <th scope="col">type</th>
              <th scope="col">
                <span className="visually-hidden">remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, t], i) => (
              <tr key={key}>
                <td>
                  <DraftInput
                    id={`${a11y.id}-name-${i}`}
                    aria-label={`${label} field name`}
                    aria-describedby={a11y["aria-describedby"]}
                    aria-invalid={a11y["aria-invalid"]}
                    initial={key}
                    onCommit={(text) => rename(i, text.trim())}
                  />
                </td>
                <td>
                  <DraftInput
                    id={`${a11y.id}-type-${i}`}
                    aria-label={`${label} type of ${key}`}
                    aria-describedby={a11y["aria-describedby"]}
                    aria-invalid={a11y["aria-invalid"]}
                    initial={t}
                    onCommit={(text) =>
                      onChange(entries.map(([k, old], j) => (j === i ? [k, text.trim()] : [k, old])))
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="row-remove"
                    aria-label={`remove ${key} from ${label}`}
                    onClick={() => onChange(entries.filter((_, j) => j !== i).map(([k, v]) => [k, v]))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row-add">
        <input
          id={a11y.id}
          type="text"
          spellCheck={false}
          aria-label={`new ${label} field name`}
          placeholder="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <input
          type="text"
          spellCheck={false}
          aria-label={`new ${label} field type`}
          placeholder="type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="ghost small" onClick={add} disabled={name.trim() === ""}>
          add
        </button>
      </div>
    </div>
  );
}
