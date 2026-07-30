"use client";
// SPDX-License-Identifier: Apache-2.0

import { formatSpec } from "@ccgrapher/core";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import { useMemo, useState } from "react";
import { buildModel, type Model } from "../lib/graph-model";
import { DEFAULT_FIXTURE, FIXTURES } from "../lib/fixtures";
import { SpecNode } from "./spec-node";
import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = { spec: SpecNode };

export function Editor() {
  const [source, setSource] = useState(FIXTURES[DEFAULT_FIXTURE]!);
  const [repaired, setRepaired] = useState(false);

  // Re-lints on every keystroke. Parsing and linting a spec this size is
  // microseconds, so there is nothing to debounce.
  const model = useMemo(() => buildModel(source, repaired), [source, repaired]);

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
              key={`${model.nodes.length}-${repaired}`}
              nodes={model.nodes}
              edges={model.edges}
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
