// SPDX-License-Identifier: Apache-2.0
import { extname } from "node:path";
import { writeFileSync } from "node:fs";
import { parseArgs } from "../args.js";
import { withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { lint } from "@ccgrapher/lint";
import { renderExcalidraw } from "@ccgrapher/render-excalidraw";
import { renderMermaid } from "@ccgrapher/render-mermaid";
import { renderSvg } from "@ccgrapher/render-svg";

const FORMATS = ["svg", "mermaid", "excalidraw"] as const;
type Format = (typeof FORMATS)[number];

const BY_EXTENSION: Record<string, Format> = {
  ".svg": "svg",
  ".mmd": "mermaid",
  ".md": "mermaid",
  ".excalidraw": "excalidraw",
  ".json": "excalidraw",
};

export function renderCommand(args: string[]): number {
  const { values, positionals } = parseArgs("render", {
    args,
    options: {
      out: { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      /** Render the repaired graph instead of the graph as written. */
      fix: { type: "boolean", default: false },
      header: { type: "boolean", default: true },
      "embed-font": { type: "boolean", default: true },
      grain: { type: "boolean", default: true },
      /** Do not mark fake edges. */
      plain: { type: "boolean", default: false },
    },
    allowPositionals: true,
    // Node's parseArgs needs this for `--no-header` and friends.
    allowNegative: true,
  });

  const spec = positionals[0];
  if (!spec) {
    process.stderr.write("ccg render: no spec file given\n");
    return 2;
  }

  const out = values.out;
  const format = resolveFormat(values.format, out);
  if (!format) {
    process.stderr.write(
      `ccg render: unknown format '${values.format ?? extname(out ?? "")}' (expected ${FORMATS.join(", ")})\n`,
    );
    return 2;
  }

  const original = loadGraph(spec);
  const result = lint(original);
  const graph = values.fix ? withEdges(original, result.repairedEdges) : original;

  const fakeEdges =
    values.plain || values.fix
      ? []
      : result.findings.filter((f) => f.rule === "FAKE_EDGE" && f.edge).map((f) => f.edge!);

  const text = emit(format, graph, original, fakeEdges, {
    fix: values.fix,
    header: values.header,
    embedFont: values["embed-font"],
    fenced: extname(out ?? "") === ".md",
    grain: values.grain,
  });

  if (out) {
    writeFileSync(out, text, "utf8");
    const layers = values.fix ? result.layersAfter : result.layersBefore;
    process.stderr.write(
      `wrote ${out} — ${format}, ${layers} layers, ${graph.nodes.size} nodes\n`,
    );
  } else {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  return 0;
}

function emit(
  format: Format,
  graph: Graph,
  original: Graph,
  fakeEdges: Array<{ from: string; to: string }>,
  options: { fix: boolean; header: boolean; embedFont: boolean; fenced: boolean; grain: boolean },
): string {
  const title = options.fix ? `${original.spec.name} (repaired)` : original.spec.name;

  switch (format) {
    case "mermaid":
      return renderMermaid(graph, { fakeEdges, fenced: options.fenced });
    case "excalidraw":
      return `${JSON.stringify(renderExcalidraw(layoutGraph(graph), { fakeEdges }), null, 2)}\n`;
    case "svg":
      return renderSvg(layoutGraph(graph), {
        header: options.header,
        embedFont: options.embedFont,
        grain: options.grain,
        fakeEdges,
        title,
      });
  }
}

function resolveFormat(explicit: string | undefined, out: string | undefined): Format | null {
  if (explicit) {
    return (FORMATS as readonly string[]).includes(explicit) ? (explicit as Format) : null;
  }
  if (out) {
    const guess = BY_EXTENSION[extname(out).toLowerCase()];
    return guess ?? null;
  }
  return "svg";
}
