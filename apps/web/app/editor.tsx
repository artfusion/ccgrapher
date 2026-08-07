"use client";
// SPDX-License-Identifier: Apache-2.0

import { formatSpec } from "@ccgrapher/core";
import { HeatData } from "@ccgrapher/trace";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
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
import {
  DEFAULT_SERVER_URL,
  useRunState,
  useTraceServer,
  type RunConnection,
  type RunSummary,
} from "../lib/run-state";
import { SpecNode } from "./spec-node";
import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = { spec: SpecNode };

export function Editor() {
  const [source, setSource] = useState(FIXTURES[DEFAULT_FIXTURE]!);
  const [repaired, setRepaired] = useState(false);

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
  const view = useMemo(() => {
    if (!model.ok) return { nodes: [], edges: [], legend: undefined };
    if (heat) {
      const { nodes, legend } = applyHeat(model.nodes, heat);
      // Heat is keyed by node; it has nothing to say about an edge.
      return { nodes, edges: model.edges, legend };
    }
    const overlaid = applyRunState(model.nodes, model.edges, connection?.run);
    // Capabilities are keyed by node too, so the edges pass straight through.
    const nodes = applyCapabilityState(overlaid.nodes, connection?.run);
    return { nodes, edges: overlaid.edges, legend: undefined };
  }, [model, connection?.run, heat]);

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

  return (
    <div className="app">
      <header>
        <h1>ccgrapher</h1>
        <p>
          An edge only exists if real data passes along it. Delete the fake ones and the graph
          goes wide instead of tall.
        </p>
        <div className="controls">
          <select
            value=""
            onChange={(e) => {
              const next = FIXTURES[e.target.value];
              if (next) {
                setSource(next);
                setRepaired(false);
              }
            }}
          >
            <option value="">load an example…</option>
            {Object.keys(FIXTURES).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

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
          {!model.ok ? (
            <pre className="error">{model.error}</pre>
          ) : (
            <ReactFlow
              // Remounted only when the shape of the graph changes, so `fitView`
              // reframes a new spec. Run state is deliberately not in this key:
              // it changes on every event, and a key that moved with it would
              // remount the whole canvas several times a second.
              key={`${model.nodes.length}-${repaired}`}
              nodes={view.nodes}
              edges={view.edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#DDD5C8" gap={22} size={1.4} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}

          {view.legend && <HeatLegend legend={view.legend} />}
          {dropping && <div className="drop-hint">drop a heat file to tint the graph</div>}
        </section>
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
