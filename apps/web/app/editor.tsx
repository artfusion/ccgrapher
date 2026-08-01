"use client";
// SPDX-License-Identifier: Apache-2.0

import { formatSpec } from "@ccgrapher/core";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { buildModel, type Model } from "../lib/graph-model";
import { applyRunState } from "../lib/overlay";
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
  // See lib/overlay.ts: run state may add to `data` and nothing else.
  const view = useMemo(
    () =>
      model.ok
        ? applyRunState(model.nodes, model.edges, connection?.run)
        : { nodes: [], edges: [] },
    [model, connection?.run],
  );

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

        <section className="pane canvas">
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
