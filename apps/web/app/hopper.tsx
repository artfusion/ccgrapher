"use client";
// SPDX-License-Identifier: Apache-2.0

import { formatSpec, parseSpec, type NodeSpec, type WorkflowSpec } from "@ccgrapher/core";
import type { Started } from "@ccgrapher/lint";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  checkNow,
  ENABLE_DRAFTING,
  itemsFrom,
  postDraft,
  statusOf,
  type DraftResponse,
  type HopperItem,
} from "../lib/hopper";

/**
 * The hopper: a brain dump goes in at the top of the canvas, and each piece of
 * work in it comes out as a drafted step the reader can accept, edit or reject.
 *
 * The order is the point. Submitting shows the parse first (what was
 * understood as work, what is already a step, what is a question for the
 * reader, what was set aside, each with its reason) and nothing on the canvas
 * moves. The drafts can be shown on the canvas as ghosts, and opened in the
 * inspector to correct them. Only accepting one writes anything: one undoable
 * edit to the spec, after which the boxes travel to where its declarations put
 * it and one sentence says where that is and why.
 *
 * A rejected draft does not vanish. It stays, with the reason, until the
 * reader dismisses it.
 */

export interface HopperState {
  readonly brainDump: string;
  readonly setBrainDump: (text: string) => void;
  readonly phase: "idle" | "sending" | "parsed" | "off" | "unreachable" | "error";
  readonly error?: string;
  readonly response?: DraftResponse;
  readonly items: readonly HopperItem[];
  readonly showGhosts: boolean;
  readonly setShowGhosts: (show: boolean) => void;
  readonly narration?: string;
  readonly submit: (serverUrl: string, spec: string, started: Started) => Promise<void>;
  readonly accept: (id: string, spec: WorkflowSpec, started: Started, write: (source: string) => void) => void;
  readonly reject: (id: string, reason: string) => void;
  readonly reconsider: (id: string) => void;
  readonly dismiss: (id: string) => void;
  /** An edit made in the inspector to a drafted step: the whole spec text it produced. */
  readonly editFromSource: (id: string, source: string) => void;
}

export function useHopper(): HopperState {
  const [brainDump, setBrainDump] = useState("");
  const [phase, setPhase] = useState<HopperState["phase"]>("idle");
  const [error, setError] = useState<string>();
  const [response, setResponse] = useState<DraftResponse>();
  const [items, setItems] = useState<readonly HopperItem[]>([]);
  const [showGhosts, setShowGhosts] = useState(false);
  const [narration, setNarration] = useState<string>();

  const update = useCallback((id: string, change: (item: HopperItem) => HopperItem) => {
    setItems((all) => all.map((item) => (item.node.id === id ? change(item) : item)));
  }, []);

  const submit = useCallback(async (serverUrl: string, spec: string, started: Started) => {
    setPhase("sending");
    setError(undefined);
    const outcome = await postDraft(serverUrl, { brainDump, spec, started: [...started] });
    if (outcome.kind === "parsed") {
      setResponse(outcome.response);
      setItems(itemsFrom(outcome.response));
      setNarration(undefined);
      setPhase("parsed");
    } else if (outcome.kind === "error") {
      setError(outcome.message);
      setPhase("error");
    } else {
      setPhase(outcome.kind);
    }
  }, [brainDump]);

  const accept = useCallback(
    (id: string, spec: WorkflowSpec, started: Started, write: (source: string) => void) => {
      const item = items.find((i) => i.node.id === id);
      if (!item) return;
      // Checked again now: the spec, and the run, may both have moved since
      // the draft was made, and a step that has started since is still a fact.
      const check = checkNow(spec, item, started);
      if (!check.spec || !check.placement) {
        update(id, (i) => ({ ...i, status: "rejected", reason: check.refusal ?? "it could not be placed" }));
        setNarration(`“${item.node.label}” was not placed: ${check.refusal ?? "it could not be placed"}`);
        return;
      }
      write(formatSpec(check.spec));
      const sentence = `“${item.node.label}”: ${check.placement.sentence}`;
      update(id, (i) => ({ ...i, status: "accepted", reason: undefined, narration: sentence }));
      setNarration(sentence);
    },
    [items, update],
  );

  const reject = useCallback(
    (id: string, reason: string) => update(id, (i) => ({ ...i, status: "rejected", reason })),
    [update],
  );
  const reconsider = useCallback(
    (id: string) => update(id, (i) => ({ ...i, status: "pending", reason: undefined })),
    [update],
  );
  const dismiss = useCallback((id: string) => setItems((all) => all.filter((i) => i.node.id !== id)), []);

  const editFromSource = useCallback(
    (id: string, source: string) => {
      let node: NodeSpec | undefined;
      try {
        node = parseSpec(source).nodes.find((n) => n.id === id);
      } catch {
        return;
      }
      if (node) update(id, (i) => ({ ...i, node: node! }));
    },
    [update],
  );

  return {
    brainDump,
    setBrainDump,
    phase,
    error,
    response,
    items,
    showGhosts,
    setShowGhosts,
    narration,
    submit,
    accept,
    reject,
    reconsider,
    dismiss,
    editFromSource,
  };
}

export function Hopper({
  hopper,
  serverUrl,
  spec,
  specSource,
  started,
  onWrite,
  onEditDraft,
}: {
  hopper: HopperState;
  serverUrl: string;
  /** The spec as written, or undefined while the text does not parse. */
  spec: WorkflowSpec | undefined;
  specSource: string;
  started: Started;
  /** Writes the spec: one undoable edit, through the same history the inspector uses. */
  onWrite: (source: string) => void;
  /** Opens a drafted step in the inspector. */
  onEditDraft: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const textId = useId();
  const parseHeading = useRef<HTMLHeadingElement>(null);
  const [focusCard, setFocusCard] = useState<string>();

  // The parse takes focus when it arrives, so a keyboard reader lands on what
  // was understood rather than back on the button they pressed.
  useEffect(() => {
    if (hopper.phase === "parsed") parseHeading.current?.focus();
  }, [hopper.phase, hopper.response]);

  // After accept or reject the button pressed is gone; focus goes to its card.
  useEffect(() => {
    if (focusCard === undefined) return;
    document.getElementById(cardTitleId(focusCard))?.focus();
    setFocusCard(undefined);
  }, [focusCard]);

  const sending = hopper.phase === "sending";
  const canSend = spec !== undefined && hopper.brainDump.trim() !== "" && !sending;

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend) void hopper.submit(serverUrl, specSource, started);
  };

  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
  };

  const pending = spec ? hopper.items.filter((i) => statusOf(i, spec) === "pending").length : 0;

  return (
    <section className={`hopper${open ? " open" : ""}`} aria-labelledby={`${bodyId}-title`}>
      <div className="hopper-head">
        <h2 id={`${bodyId}-title`}>hopper</h2>
        <button
          type="button"
          className="hopper-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "fold away" : pending > 0 ? `${pending} draft${pending === 1 ? "" : "s"} waiting` : "drop in ideas"}
        </button>
      </div>

      {/* Outside the fold, so a placement is announced even with the panel shut. */}
      <p className="hopper-narration" role="status" aria-live="polite">
        {hopper.narration ?? ""}
      </p>

      <div id={bodyId} className="hopper-body" hidden={!open}>
        <form onSubmit={send}>
          <label htmlFor={textId}>Brain dump: work, fixes, questions, as they come</label>
          <textarea
            id={textId}
            value={hopper.brainDump}
            rows={4}
            onChange={(e) => hopper.setBrainDump(e.target.value)}
            onKeyDown={onTextKey}
            aria-describedby={`${textId}-note`}
          />
          <div className="hopper-actions">
            <button type="submit" disabled={!canSend} aria-keyshortcuts="Control+Enter Meta+Enter">
              {sending ? "reading it…" : "parse"}
            </button>
            <span id={`${textId}-note`} className="hopper-note">
              Goes to the local server at {serverUrl}, which sends the brain dump and the spec to the model.
              Nothing in the plan changes until you accept a step.
            </span>
          </div>
        </form>

        {spec === undefined && <p className="hopper-state bad">The spec does not parse, so there is nowhere to place anything yet.</p>}
        {hopper.phase === "off" && (
          <p className="hopper-state" role="alert">
            Drafting is not turned on at {serverUrl}. {ENABLE_DRAFTING}
          </p>
        )}
        {hopper.phase === "unreachable" && (
          <p className="hopper-state" role="alert">
            Nothing answered at {serverUrl}. {ENABLE_DRAFTING}
          </p>
        )}
        {hopper.phase === "error" && (
          <p className="hopper-state bad" role="alert">
            {hopper.error}
          </p>
        )}

        {hopper.response && spec && (
          <Parse
            response={hopper.response}
            items={hopper.items}
            spec={spec}
            started={started}
            headingRef={parseHeading}
            showGhosts={hopper.showGhosts}
            onShowGhosts={hopper.setShowGhosts}
            onAccept={(id) => {
              hopper.accept(id, spec, started, onWrite);
              setFocusCard(id);
            }}
            onReject={(id) => {
              hopper.reject(id, "rejected by you");
              setFocusCard(id);
            }}
            onReconsider={(id) => {
              hopper.reconsider(id);
              setFocusCard(id);
            }}
            onDismiss={(id) => {
              hopper.dismiss(id);
              parseHeading.current?.focus();
            }}
            onEdit={onEditDraft}
          />
        )}
      </div>
    </section>
  );
}

const cardTitleId = (id: string) => `hopper-card-${id}`;

function Parse({
  response,
  items,
  spec,
  started,
  headingRef,
  showGhosts,
  onShowGhosts,
  onAccept,
  onReject,
  onReconsider,
  onDismiss,
  onEdit,
}: {
  response: DraftResponse;
  items: readonly HopperItem[];
  spec: WorkflowSpec;
  started: Started;
  headingRef: RefObject<HTMLHeadingElement | null>;
  showGhosts: boolean;
  onShowGhosts: (show: boolean) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onReconsider: (id: string) => void;
  onDismiss: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const labelOf = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="hopper-parse">
      <h3 ref={headingRef} tabIndex={-1}>
        What it understood
      </h3>
      <p className="hopper-summary">
        {count(response.candidates.length, "new step", "new steps")},{" "}
        {count(response.duplicates.length, "already in the plan", "already in the plan")},{" "}
        {count(response.waitingOnYou.length, "waiting on you", "waiting on you")},{" "}
        {count(response.setAside.length, "set aside", "set aside")}. Read with {response.model}; checked in a fresh
        context, then linted.
      </p>

      {items.length > 0 && (
        <>
          <label className="hopper-ghosts">
            <input type="checkbox" checked={showGhosts} onChange={(e) => onShowGhosts(e.target.checked)} />
            show the drafts on the canvas, as ghosts
          </label>
          {showGhosts && (
            <p className="hopper-note">
              While the ghosts are shown the canvas is a preview: links drawn on it are not kept.
            </p>
          )}
          <ul className="hopper-cards" aria-label="drafted steps">
            {items.map((item) => (
              <Card
                key={item.node.id}
                item={item}
                spec={spec}
                started={started}
                onAccept={onAccept}
                onReject={onReject}
                onReconsider={onReconsider}
                onDismiss={onDismiss}
                onEdit={onEdit}
              />
            ))}
          </ul>
        </>
      )}

      {response.duplicates.length > 0 && (
        <section aria-label="already in the plan">
          <h4>Already in the plan</h4>
          <ul className="hopper-list">
            {response.duplicates.map((d, i) => (
              <li key={i}>
                <q>{d.text}</q> joins <strong>{labelOf(d.nodeId)}</strong>
                <span className="why"> {d.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {response.waitingOnYou.length > 0 && (
        <section aria-label="waiting on you">
          <h4>Waiting on you</h4>
          <ul className="hopper-list">
            {response.waitingOnYou.map((w, i) => (
              <li key={i}>
                <span className="tag">{w.kind}</span> {w.text}
                <span className="why"> Recommended: {w.recommendation}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {response.setAside.length > 0 && (
        <section aria-label="set aside">
          <h4>Set aside</h4>
          <ul className="hopper-list">
            {response.setAside.map((s, i) => (
              <li key={i}>
                <q>{s.text}</q>
                <span className="why"> {s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Card({
  item,
  spec,
  started,
  onAccept,
  onReject,
  onReconsider,
  onDismiss,
  onEdit,
}: {
  item: HopperItem;
  spec: WorkflowSpec;
  started: Started;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onReconsider: (id: string) => void;
  onDismiss: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const { node, candidate } = item;
  const status = statusOf(item, spec);
  const undone = item.status === "accepted" && status === "pending";
  // Against the spec and the run as they are now, not as they were at drafting.
  const check = status === "pending" ? checkNow(spec, item, started) : undefined;
  const name = `“${node.label}”`;
  const fields = (record: Readonly<Record<string, string>>) => Object.keys(record).join(", ") || "nothing";

  return (
    <li className={`hopper-card status-${status}`}>
      <h4 id={cardTitleId(node.id)} tabIndex={-1}>
        {node.label}
        <span className="hopper-status">
          {status === "pending" ? "draft" : status === "accepted" ? "placed" : "rejected"}
        </span>
      </h4>
      <p className="hopper-shape">
        {node.kind}
        {node.model === null ? ", plain code" : node.model ? `, ${node.model}` : ""} · takes {fields(node.in)} · gives{" "}
        {fields(node.out)}
        {node.writes && node.writes.length > 0 ? ` · writes ${node.writes.join(", ")}` : ""}
      </p>
      <p className="hopper-why">
        {candidate.rationale} <q>{candidate.source}</q>
      </p>
      <p className="hopper-review">
        <span className="tag">{candidate.review.agrees ? "check agrees" : "check revised"}</span>{" "}
        {candidate.review.note}
      </p>

      {status === "accepted" && <p className="hopper-placed">{item.narration}</p>}
      {status === "rejected" && <p className="hopper-reason">Rejected: {item.reason}</p>}
      {undone && <p className="hopper-note">Taken back by an undo; it can be placed again.</p>}

      {check && (
        <>
          {check.refusal ? (
            <p className="hopper-reason">Cannot be placed: {check.refusal}</p>
          ) : (
            check.placement && <p className="hopper-would">Would be {lowerFirst(check.placement.sentence)}</p>
          )}
          {check.findings.length > 0 && (
            <ul className="hopper-findings" aria-label={`lint findings for ${name}`}>
              {check.findings.map((f, i) => (
                <li key={i} className={f.severity}>
                  <span className="rule">{f.rule}</span> {f.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="hopper-card-actions">
        {status === "pending" && (
          <>
            <button
              type="button"
              disabled={check?.refusal !== undefined}
              onClick={() => onAccept(node.id)}
              aria-label={`accept ${name}`}
            >
              accept
            </button>
            <button type="button" className="ghost" onClick={() => onEdit(node.id)} aria-label={`edit ${name} in the inspector`}>
              edit
            </button>
            <button type="button" className="ghost" onClick={() => onReject(node.id)} aria-label={`reject ${name}`}>
              reject
            </button>
          </>
        )}
        {status === "rejected" && (
          <>
            <button type="button" className="ghost" onClick={() => onReconsider(node.id)} aria-label={`reconsider ${name}`}>
              reconsider
            </button>
            <button type="button" className="ghost" onClick={() => onDismiss(node.id)} aria-label={`dismiss ${name}`}>
              dismiss
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}
