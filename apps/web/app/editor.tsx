"use client";
// SPDX-License-Identifier: Apache-2.0

import { formatSpec } from "@ccgrapher/core";
import { HeatData } from "@ccgrapher/trace";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildModel, type Model } from "../lib/graph-model";
import { applyRunState } from "../lib/overlay";
import { applyCapabilityState } from "../lib/capability";
import {
  applyHeat,
  formatHeat,
  HEAT_UNMEASURED_FILL,
  type HeatLegend as HeatLegendData,
} from "../lib/heat";
import { DEFAULT_FIXTURE, FIXTURES } from "../lib/fixtures";
import { decodeSpecFragment, isViewerHash } from "../lib/viewer-link";
import { edit, redo, startHistory, undo, type SpecHistory } from "../lib/spec-history";
import {
  addEdge,
  connectionRefusal,
  fieldChoices,
  retargetEdge,
  deleteEdge,
  edgeAt,
  type EdgeRef,
  type GestureResult,
} from "../lib/edge-gestures";
import { Inspector } from "./inspector";
import { CanvasNotice, DragNote, EdgeChooser } from "./edge-panel";
import type { EdgeGestures } from "./canvas/canvas";
import { Hopper, useHopper } from "./hopper";
import { markGhosts, specForEditing, startedSteps, statusOf, withGhosts } from "../lib/hopper";
import {
  DEFAULT_SERVER_URL,
  useRunState,
  useTraceServer,
  type RunConnection,
  type RunSummary,
} from "../lib/run-state";

// @joint/core touches `document` at import, and `pnpm --filter @ccgrapher/web
// build` runs under Next's server build — so the canvas is client-only,
// loaded after hydration rather than during SSR.
const Canvas = dynamic(() => import("./canvas/canvas").then((m) => m.Canvas), { ssr: false });

/** How long a note about a gesture stays, unless dismissed first. A refusal stays longer: it has a reason to read. */
const NOTICE_MS = { done: 5000, refused: 9000 } as const;

/** Keys typed into a field are the field's, never a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
  );
}

export function Editor() {
  // The spec text, with the undo history of edits made from the picture.
  // `setSource` replaces the text and starts the history afresh (see
  // lib/spec-history.ts for why typing does not join it); `editSource` is a
  // recorded edit, one undo step each.
  const [history, setHistory] = useState<SpecHistory>(() =>
    startHistory(FIXTURES[DEFAULT_FIXTURE]!),
  );
  const source = history.source;
  const setSource = useCallback((next: string) => setHistory(startHistory(next)), []);
  const editSource = useCallback((next: string) => {
    setHistory((current) => edit(current, next));
    setRepaired(false);
  }, []);
  const [repaired, setRepaired] = useState(false);

  // A spec *loaded* (an example, a file, a link) is a new drawing: the canvas
  // remounts on it and frames it afresh. Everything else (typing, the panel,
  // a repair, the preview toggle, an edge gesture) is an edit, and moves the
  // boxes of the drawing already on screen without touching pan or zoom.
  const [loaded, setLoaded] = useState(0);
  const loadSource = useCallback(
    (next: string) => {
      setSource(next);
      setRepaired(false);
      setLoaded((n) => n + 1);
    },
    [setSource],
  );

  // The step the inspector is showing. Kept by id, so a step that briefly
  // disappears while its id is being retyped comes back selected.
  const [selectedId, setSelectedId] = useState<string>();
  const [focusToken, setFocusToken] = useState(0);
  // The edge the inspector is showing, by its ends. Shown over the step's
  // fields while set; clearing it goes back to the step. Read through
  // `selectedEdge` below, which drops it once the spec no longer has it (an
  // undo, a typed edit), rather than leaving a panel about nothing.
  const [pickedEdge, setSelectedEdge] = useState<EdgeRef>();
  const [edgeFocusToken, setEdgeFocusToken] = useState(0);
  const selectFromCanvas = useCallback((id: string | undefined) => {
    setSelectedId(id);
    setSelectedEdge(undefined);
    // A step picked on the canvas takes keyboard focus to its fields.
    if (id !== undefined) setFocusToken((n) => n + 1);
  }, []);
  const selectEdgeFromCanvas = useCallback((edge: EdgeRef) => {
    setSelectedEdge(edge);
    setEdgeFocusToken((n) => n + 1);
  }, []);

  // A spec carried in the URL fragment (see lib/viewer-link.ts) — read once,
  // client-side only, so a static export needs no server route to answer it.
  // Starts false because a static page has no fragment at render time; the
  // effect below corrects it on mount, before the reader has had a chance to
  // look at anything.
  const [viewerMode, setViewerMode] = useState(false);
  useEffect(() => {
    const hash = window.location.hash;
    setViewerMode(isViewerHash(hash));
    const fromUrl = decodeSpecFragment(hash);
    if (fromUrl !== undefined) loadSource(fromUrl);
    // Intentionally once: the fragment is how a link *arrives*, not a value
    // this page ever writes back to, so there is nothing to keep in sync.
  }, []);

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [runId, setRunId] = useState<string>();
  const server = useTraceServer(serverUrl);
  const connection = useRunState(serverUrl, runId);

  // Heat files, keyed by the metric they measure, so loading a second file of the
  // same metric replaces it rather than growing a duplicate entry in the toggle.
  const [heatFiles, setHeatFiles] = useState<Record<string, HeatData>>({});
  const [metric, setMetric] = useState<string>();
  const [heatError, setHeatError] = useState<string>();
  const [dropping, setDropping] = useState(false);
  const heat = metric === undefined ? undefined : heatFiles[metric];

  // The live UI does not exist until a trace server answers. With nothing
  // serving, this is the local YAML scratchpad it has always been. Once a server
  // has been seen the bar stays, so a URL typed at a server that is now down
  // still has somewhere to be typed.
  const [everSeen, setEverSeen] = useState(false);
  useEffect(() => {
    if (server.reachable) setEverSeen(true);
  }, [server.reachable]);

  // Re-lints on every keystroke. Parsing and linting a spec this size is
  // microseconds, so there is nothing to debounce.
  const model = useMemo(() => buildModel(source, repaired), [source, repaired]);

  // While the text does not parse (half-way through typing a line, say) the
  // canvas keeps the last picture that did, greyed and inert under the error,
  // so the pan and zoom survive and the boxes move on from where they were
  // once the spec parses again. A load clears it: a file that does not parse
  // has no picture of its own to show.
  const [held, setHeld] = useState<{ model: Model; loaded: number }>();
  if (model.ok && (held?.model !== model || held.loaded !== loaded)) setHeld({ model, loaded });
  const drawn = model.ok ? model : held?.loaded === loaded ? held.model : undefined;

  // ── the hopper ──────────────────────────────────────────────────────────
  // Drafted steps live in the hopper, not in the spec, until one is accepted
  // (app/hopper.tsx). Steps the live run has started are facts it may not
  // rewire; a run of some other workflow says nothing about this one.
  const hopper = useHopper();
  const started = useMemo(() => {
    const run = connection?.run;
    const ranSpec = run?.spec?.name;
    if (ranSpec !== undefined && model.ok && ranSpec !== model.base.spec.name) return new Set<string>();
    return startedSteps(run);
  }, [connection?.run, model]);

  // The drafts as ghosts: the spec with them placed, drawn provisionally. Only
  // while the reader asks for it, so nothing moves before the parse is read.
  const ghosted = useMemo(() => {
    if (!hopper.showGhosts || !model.ok) return undefined;
    const { spec, ghosts } = withGhosts(model.base.spec, hopper.items, started);
    if (ghosts.size === 0) return undefined;
    const built = buildModel(formatSpec(spec), false);
    return built.ok ? markGhosts(built, ghosts) : undefined;
  }, [hopper.showGhosts, hopper.items, model, started]);
  const shown = ghosted ?? drawn;

  // A drafted step opened in the inspector is edited there like any step, in
  // a spec with it placed; the result goes back to the hopper, not the text.
  const draft = model.ok
    ? hopper.items.find((i) => i.node.id === selectedId && statusOf(i, model.base.spec) !== "accepted")
    : undefined;
  const draftModel = useMemo(
    () =>
      draft && model.ok
        ? buildModel(formatSpec(specForEditing(model.base.spec, draft, started)), false)
        : undefined,
    [draft, model, started],
  );

  // ── canvas -> spec ────────────────────────────────────────────────────────
  // Every gesture on the picture is a gesture on the spec. The canvas reports
  // what a drag or a click on an edge meant (app/canvas/canvas.tsx); here it
  // becomes one recorded edit through lib/edge-gestures.ts, or a refusal with
  // its reason. Either way the canvas has already put its drawing back as the
  // spec has it, so a refused gesture leaves nothing behind.
  const [notice, setNotice] = useState<{ tone: "done" | "refused"; text: string }>();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS[notice.tone]);
    return () => clearTimeout(timer);
  }, [notice]);

  const onGesture = useCallback(
    (result: GestureResult) => {
      if (result.ok) {
        editSource(result.source);
        setSelectedEdge(result.edge);
        // A deleted edge's panel is gone; focus goes back to the step's.
        if (!result.edge) setFocusToken((n) => n + 1);
        setNotice({ tone: "done", text: result.summary });
      } else {
        setNotice({ tone: "refused", text: result.reason });
      }
    },
    [editSource],
  );

  // A new edge waiting for its field, when the source produces more than one.
  const [choosing, setChoosing] = useState<{ from: string; to: string }>();
  const spec = model.ok ? model.base.spec : undefined;
  const selectedEdge = pickedEdge && spec && edgeAt(spec, pickedEdge) ? pickedEdge : undefined;

  const onConnect = useCallback(
    (from: string, to: string) => {
      if (!spec) return;
      const refusal = connectionRefusal(spec, from, to);
      if (refusal) return setNotice({ tone: "refused", text: refusal });
      const choices = fieldChoices(spec, from, to);
      if (choices.length === 1) return onGesture(addEdge(spec, from, to, choices[0]!.field));
      setChoosing({ from, to });
    },
    [spec, onGesture],
  );

  // Said once per visit: the first drag explains itself, later ones need not.
  const [dragNote, setDragNote] = useState<"unseen" | "showing" | "seen">("unseen");

  const gestures = useMemo<EdgeGestures | undefined>(
    () =>
      viewerMode || !spec
        ? undefined
        : {
            selectedEdge,
            onSelectEdge: selectEdgeFromCanvas,
            onConnect,
            onRetarget: (edge, end, node) => onGesture(retargetEdge(spec, edge, end, node)),
            onDeleteEdge: (edge) => onGesture(deleteEdge(spec, edge)),
            onNodeDrag: () => setDragNote((seen) => (seen === "unseen" ? "showing" : seen)),
          },
    [viewerMode, spec, selectedEdge, selectEdgeFromCanvas, onConnect, onGesture],
  );

  // Delete or Backspace removes the selected edge, Escape lets it go, and
  // undo and redo work from anywhere outside a text field. The inspector
  // handles its own keys first and marks them handled.
  useEffect(() => {
    if (viewerMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (choosing) return;
      const mod = event.metaKey || event.ctrlKey;
      if (selectedEdge && spec && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        onGesture(deleteEdge(spec, selectedEdge));
      } else if (selectedEdge && event.key === "Escape") {
        setSelectedEdge(undefined);
      } else if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHistory(event.shiftKey ? redo : undo);
        setRepaired(false);
      } else if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        setHistory(redo);
        setRepaired(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [viewerMode, choosing, selectedEdge, spec, onGesture]);

  // ── the overlay seam ──────────────────────────────────────────────────────
  // Layout has already run at this point and its output is not touched below.
  // See lib/overlay.ts and lib/heat.ts: an overlay may add to `data` and nothing
  // else. Neither of them is allowed to move anything.
  //
  // Run state and heat are alternative readings of the same nodes, not layers.
  // Two arguments, and the second is the one that decided it:
  //
  //   - They answer different questions from different times. Run state is "what
  //     is happening now"; heat is "what this has historically cost". Drawn at
  //     once, a reader has no way to tell which colour is answering which, and
  //     the picture implies a relationship between them that does not exist.
  //   - They collide in hue, not in channel. Run status is drawn in the border
  //     and the corner mark; heat washes the card. Those would coexist happily —
  //     except that heat's hot end *is* `--accent`, the same orange the ring
  //     around a running node uses. On a card this size a fill and a ring in one
  //     hue read as one signal, so a hot node would look like a busy one.
  //
  // So heat wins the canvas outright while it is showing, run state is not
  // merged at all, and the heat bar says so in words rather than letting the
  // reader notice the live tint went missing.
  //
  // Capability trouble goes with the run rather than beside heat, for the same
  // reason: it is a present-tense reading of the run — what a step reached for a
  // moment ago and could not find — so it lives in the branch where the run
  // lives, and disappears with it when heat takes the canvas.
  const overlaid = useMemo(() => {
    if (!shown) return { nodes: [], edges: [], legend: undefined };
    if (heat) {
      const { nodes, legend } = applyHeat(shown.nodes, heat);
      // Heat is keyed by node; it has nothing to say about an edge.
      return { nodes, edges: shown.edges, legend };
    }
    const overlaid = applyRunState(shown.nodes, shown.edges, connection?.run);
    // Capabilities are keyed by node too, so the edges pass straight through.
    const nodes = applyCapabilityState(overlaid.nodes, connection?.run);
    return { nodes, edges: overlaid.edges, legend: undefined };
  }, [shown, connection?.run, heat]);

  // The inspected step is marked on its card. Like every overlay, a flag in
  // `data` and nothing else: selecting a step moves nothing.
  const view = useMemo(
    () =>
      selectedId === undefined || viewerMode
        ? overlaid
        : {
            ...overlaid,
            nodes: overlaid.nodes.map((n) =>
              n.id === selectedId ? { ...n, data: { ...n.data, selected: true } } : n,
            ),
          },
    [overlaid, selectedId, viewerMode],
  );

  const loadHeat = async (files: readonly File[]) => {
    const loaded: Record<string, HeatData> = {};
    const failures: string[] = [];
    for (const file of files) {
      try {
        const parsed = HeatData.parse(JSON.parse(await file.text()));
        loaded[parsed.metric] = parsed;
      } catch (cause) {
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    setHeatError(failures.length === 0 ? undefined : failures.join("; "));
    const metrics = Object.keys(loaded);
    if (metrics.length === 0) return;
    setHeatFiles((current) => ({ ...current, ...loaded }));
    setMetric(metrics[0]);
  };

  const applyRepairs = () => {
    if (!model.ok) return;
    setSource(formatSpec({ ...model.graph.spec, edges: [...model.result.repairedEdges] }));
    setRepaired(false);
  };

  const repairCount = model.ok ? model.result.repairs.length : 0;

  const refuseDraftGesture = () =>
    setNotice({
      tone: "refused",
      text: "A drafted step's edges follow from its in and out. Change those, or accept it first.",
    });

  return (
    <div className={viewerMode ? "app viewer" : "app"}>
      <header>
        <h1>ccgrapher</h1>
        <p>
          An edge only exists if real data passes along it. Delete the fake ones and the graph
          goes wide instead of tall.
        </p>
        <div className="controls">
          {!viewerMode && (
            <>
              <select
                value=""
                onChange={(e) => {
                  const next = FIXTURES[e.target.value];
                  if (next) loadSource(next);
                }}
              >
                <option value="">load an example…</option>
                {Object.keys(FIXTURES).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>

              <label className="filepick">
                <input
                  type="file"
                  accept=".yaml,.yml,text/yaml,application/x-yaml"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    // So opening the same file twice in a row still fires a change.
                    e.target.value = "";
                    if (!file) return;
                    loadSource(await file.text());
                  }}
                />
                open a spec…
              </label>
            </>
          )}

          <label className={repairCount === 0 ? "disabled" : ""}>
            <input
              type="checkbox"
              checked={repaired}
              disabled={repairCount === 0}
              onChange={(e) => setRepaired(e.target.checked)}
            />
            preview repaired
          </label>

          <button type="button" onClick={applyRepairs} disabled={repairCount === 0}>
            apply {repairCount} repair{repairCount === 1 ? "" : "s"}
          </button>
        </div>

        {everSeen && (
          <LiveBar
            serverUrl={serverUrl}
            onServerUrl={setServerUrl}
            runs={server.runs}
            runId={runId}
            onRunId={setRunId}
            onRefresh={server.probe}
            reachable={server.reachable}
            connection={connection}
            specName={model.ok ? model.graph.spec.name : undefined}
          />
        )}

        <HeatBar
          files={heatFiles}
          metric={metric}
          onMetric={setMetric}
          onFiles={loadHeat}
          error={heatError}
          legend={view.legend}
          hidingRun={heat !== undefined && connection?.run !== undefined}
        />
      </header>

      <main>
        {!viewerMode && (
          <section className="pane source">
            <textarea
              spellCheck={false}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setRepaired(false);
              }}
            />
          </section>
        )}

        <section
          className={`pane canvas${dropping ? " dropping" : ""}`}
          onDragOver={(e) => {
            // Only a file drag. Dragging a node around the canvas is React Flow's.
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) return;
            setDropping(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropping(false);
            void loadHeat([...e.dataTransfer.files]);
          }}
        >
          {!viewerMode && (
            <Hopper
              hopper={hopper}
              serverUrl={serverUrl}
              spec={model.ok ? model.base.spec : undefined}
              specSource={source}
              started={started}
              onWrite={editSource}
              onEditDraft={selectFromCanvas}
            />
          )}
          {shown && (
            <div className={model.ok ? "canvas-host" : "canvas-host held"} inert={!model.ok}>
              <Canvas
                // Remounted only when a spec is loaded. An edit reaches the
                // mounted canvas as new props and moves its boxes in place.
                key={loaded}
                nodes={view.nodes}
                edges={view.edges}
                specNodes={shown.graph.spec.nodes}
                onSelect={viewerMode ? undefined : selectFromCanvas}
                // While ghosts are shown the picture is a preview: a gesture
                // made on it would be made on drafts that are not in the spec.
                gestures={model.ok && !ghosted ? gestures : undefined}
              />
            </div>
          )}
          {!viewerMode && (
            <CanvasNotice notice={notice} onDismiss={() => setNotice(undefined)} />
          )}
          {choosing && spec && (
            <EdgeChooser
              key={`${choosing.from}->${choosing.to}`}
              from={choosing.from}
              to={choosing.to}
              choices={fieldChoices(spec, choosing.from, choosing.to)}
              onChoose={(field) => {
                setChoosing(undefined);
                onGesture(addEdge(spec, choosing.from, choosing.to, field));
              }}
              onCancel={() => setChoosing(undefined)}
            />
          )}
          {dragNote === "showing" && <DragNote onDismiss={() => setDragNote("seen")} />}
          {!model.ok && (
            <pre className={drawn ? "error over" : "error"}>{model.error}</pre>
          )}

          {view.legend && <HeatLegend legend={view.legend} />}
          {dropping && <div className="drop-hint">drop a heat file to tint the graph</div>}
        </section>

        {!viewerMode && (
          <Inspector
            model={draftModel ?? model}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onEdit={draft ? (next) => hopper.editFromSource(draft.node.id, next) : editSource}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onUndo={() => {
              setHistory(undo);
              setRepaired(false);
            }}
            onRedo={() => {
              setHistory(redo);
              setRepaired(false);
            }}
            focusToken={focusToken}
            selectedEdge={selectedEdge}
            onSelectEdge={(edge) => {
              setSelectedEdge(edge);
              if (edge) setEdgeFocusToken((n) => n + 1);
            }}
            // A draft's edges are read off its `in` and `out`, never drawn, and a
            // gesture here would write the draft into the spec before it is accepted.
            onGesture={draft ? refuseDraftGesture : onGesture}
            onConnect={draft ? refuseDraftGesture : onConnect}
            edgeFocusToken={edgeFocusToken}
          />
        )}
      </main>

      <footer>
        {model.ok ? <Report model={model} /> : <span className="bad">spec error</span>}
      </footer>
    </div>
  );
}

function LiveBar({
  serverUrl,
  onServerUrl,
  runs,
  runId,
  onRunId,
  onRefresh,
  reachable,
  connection,
  specName,
}: {
  serverUrl: string;
  onServerUrl: (url: string) => void;
  runs: readonly RunSummary[];
  runId: string | undefined;
  onRunId: (id: string | undefined) => void;
  onRefresh: () => void;
  reachable: boolean;
  connection: RunConnection | undefined;
  specName: string | undefined;
}) {
  const [draft, setDraft] = useState(serverUrl);

  // A run of a different workflow would tint nothing and look like a graph where
  // nothing ever happened. Saying so is cheaper than letting the picture imply it.
  const ranSpec = connection?.run?.spec?.name;
  const mismatch = ranSpec !== undefined && specName !== undefined && ranSpec !== specName;

  return (
    <div className="controls live">
      <span className="live-label">live run</span>

      <input
        className="live-url"
        value={draft}
        spellCheck={false}
        aria-label="trace server URL"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />

      <select
        value={runId ?? ""}
        aria-label="run"
        disabled={!reachable}
        onChange={(e) => onRunId(e.target.value === "" ? undefined : e.target.value)}
      >
        <option value="">watch a run…</option>
        {runs.map((run) => (
          <option key={run.id} value={run.id}>
            {run.id}
          </option>
        ))}
      </select>

      <button type="button" className="ghost" onClick={onRefresh}>
        refresh
      </button>

      <LiveStatus reachable={reachable} connection={connection} />

      {mismatch && (
        <span className="live-state closed">
          this run is of ‘{ranSpec}’, not the spec on screen
        </span>
      )}
    </div>
  );

  function commit() {
    const next = draft.trim().replace(/\/+$/, "");
    if (next !== "" && next !== serverUrl) {
      onRunId(undefined);
      onServerUrl(next);
    }
  }
}

function LiveStatus({
  reachable,
  connection,
}: {
  reachable: boolean;
  connection: RunConnection | undefined;
}) {
  if (!reachable && !connection) {
    return <span className="live-state off">no server at that address</span>;
  }
  if (!connection) {
    return <span className="live-state idle">connected to the server, watching nothing</span>;
  }

  const run = connection.run;
  const text =
    connection.status === "connected"
      ? run
        ? `${run.status} — ${settled(run)}`
        : "connected"
      : connection.status === "reconnecting"
        ? "reconnecting, will resume where it stopped"
        : connection.status === "closed"
          ? (connection.error ?? "the stream closed")
          : "connecting…";

  return (
    <span className={`live-state ${connection.status}`} title={connection.error}>
      {text}
    </span>
  );
}

function settled(run: NonNullable<RunConnection["run"]>): string {
  let done = 0;
  let failed = 0;
  let active = 0;
  for (const node of run.nodes.values()) {
    if (node.status === "done") done += 1;
    else if (node.status === "failed") failed += 1;
    else if (node.status !== "pending") active += 1;
  }
  const parts = [`${done} done`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (active > 0) parts.push(`${active} in flight`);
  return parts.join(", ");
}

/**
 * Loading a heat file, and choosing between the ones already loaded.
 *
 * Two ways in, because one of them is undiscoverable on its own: a file picker
 * that is visible whether or not anything is loaded, and a drop anywhere on the
 * canvas. Both take several files at once, which is how the metric toggle comes
 * to have more than one thing in it.
 */
function HeatBar({
  files,
  metric,
  onMetric,
  onFiles,
  error,
  legend,
  hidingRun,
}: {
  files: Record<string, HeatData>;
  metric: string | undefined;
  onMetric: (metric: string | undefined) => void;
  onFiles: (files: readonly File[]) => void;
  error: string | undefined;
  legend: HeatLegendData | undefined;
  hidingRun: boolean;
}) {
  const metrics = Object.keys(files);

  return (
    <div className="controls heat">
      <span className="heat-label">heat</span>

      <label className="filepick">
        <input
          type="file"
          accept="application/json,.json"
          multiple
          onChange={(e) => {
            onFiles([...(e.target.files ?? [])]);
            // So loading the same file twice in a row still fires a change.
            e.target.value = "";
          }}
        />
        {metrics.length === 0 ? "choose a heat file…" : "add another…"}
      </label>

      {metrics.length === 0 ? (
        <span className="heat-hint">
          or drop one on the canvas — <code>ccg trace stats … --heat</code>,{" "}
          <code>ccg retro … --heat</code>
        </span>
      ) : (
        <select
          value={metric ?? ""}
          aria-label="heat metric"
          onChange={(e) => onMetric(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">off — show the run instead</option>
          {metrics.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}

      {legend && (
        <span className="heat-state">
          {legend.measured} of {legend.measured + legend.unmeasured} nodes measured
          {legend.unmatched > 0 && (
            <em>
              {" "}
              · {legend.unmatched} entr{legend.unmatched === 1 ? "y" : "ies"} in the file match no
              node here
            </em>
          )}
        </span>
      )}

      {/* Not left for the reader to notice by the tint going missing. */}
      {hidingRun && <span className="heat-state warn">the live run tint is hidden while heat is shown</span>}

      {error && <span className="heat-state bad">{error}</span>}
    </div>
  );
}

/**
 * What the colours mean, in the file's own unit, plus the one entry that is not
 * a colour on the ramp at all.
 *
 * The unmeasured swatch is set apart rather than sitting at the cold end of the
 * row, because the whole point of the sparse map is that "not measured" is not a
 * low value. Its hatch appears nowhere else in the drawing.
 */
function HeatLegend({ legend }: { legend: HeatLegendData }) {
  return (
    <div className="heat-legend">
      <div className="heat-legend-head">
        <strong>{legend.metric}</strong>
        <span>{legend.unit}</span>
      </div>

      {legend.bands.length > 0 ? (
        <>
          <div className="heat-scale">
            {legend.bands.map((band, i) => (
              <span
                key={i}
                className="heat-swatch"
                style={{ background: band.fill }}
                title={`${formatHeat(band.from, legend.unit)} – ${formatHeat(band.to, legend.unit)}`}
              />
            ))}
          </div>
          <div className="heat-ends">
            <span>{formatHeat(legend.bands[0]!.from, legend.unit)}</span>
            <span>{formatHeat(legend.bands.at(-1)!.to, legend.unit)}</span>
          </div>
          {/* Stated, because a ramp anchored at its own minimum and one anchored
              at zero look identical and mean different things. */}
          <p className="heat-note">scale runs from zero, banded in five</p>
          {/* A wall of one colour looks like a finding. It is not one. */}
          {legend.flat && (
            <p className="heat-note">every measured node reads the same — no spread here</p>
          )}
        </>
      ) : legend.measured === 0 ? (
        <p className="heat-note">no node on this graph is measured by this file</p>
      ) : (
        <p className="heat-note">every measured node reads zero</p>
      )}

      <div className="heat-legend-row">
        <span className="heat-swatch" style={{ background: HEAT_UNMEASURED_FILL }} />
        <span>no data — never measured, not a low value</span>
      </div>

      <p className="heat-source">{legend.source}</p>
    </div>
  );
}

function Report({ model }: { model: Model }) {
  const { result } = model;
  const errors = result.findings.filter((f) => f.severity === "error").length;

  return (
    <>
      <div className="path">
        <strong>{result.layersBefore}</strong> layers
        {result.layersAfter < result.layersBefore && (
          <>
            {" → "}
            <strong className="good">{result.layersAfter}</strong> after repair
          </>
        )}
      </div>

      {result.findings.length === 0 ? (
        <div className="clean">no findings</div>
      ) : (
        <ul className="findings">
          {result.findings.map((f, i) => (
            <li key={i} className={f.severity}>
              <span className="rule">{f.rule}</span>
              {f.message}
              {f.phase === "repaired" && <em> (after repair)</em>}
            </li>
          ))}
        </ul>
      )}

      <div className="tally">
        {errors} error{errors === 1 ? "" : "s"}, {result.findings.length - errors} warning
        {result.findings.length - errors === 1 ? "" : "s"}
      </div>
    </>
  );
}
