// SPDX-License-Identifier: Apache-2.0
import { extname } from "node:path";
import { writeFileSync } from "node:fs";
import { parseArgs } from "../args.js";
import { stepLegend, withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { lint, renderMarksFor, type RenderMarks } from "@ccgrapher/lint";
import { renderExcalidraw } from "@ccgrapher/render-excalidraw";
import { renderMermaid } from "@ccgrapher/render-mermaid";
import { renderSvg, wrapHtml } from "@ccgrapher/render-svg";

const FORMATS = ["svg", "mermaid", "excalidraw", "html"] as const;
type Format = (typeof FORMATS)[number];

const BY_EXTENSION: Record<string, Format> = {
  ".svg": "svg",
  ".mmd": "mermaid",
  ".md": "mermaid",
  ".excalidraw": "excalidraw",
  ".json": "excalidraw",
  ".html": "html",
  ".htm": "html",
};

export function renderCommand(args: string[]): number {
  const { values, positionals } = parseArgs("render", {
    args,
    options: {
      out: { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      /** Render the repaired graph instead of the graph as written. */
      fix: { type: "boolean", default: false },
      /** Write a before and an after: two specs, or one spec and its repair. */
      pair: { type: "boolean", default: false },
      header: { type: "boolean", default: true },
      "embed-font": { type: "boolean", default: true },
      grain: { type: "boolean", default: true },
      /** Do not mark lint findings: no ring, caption, red edge or line. Counts stay. */
      plain: { type: "boolean", default: false },
      /** Number the steps in execution order and list them under the picture. */
      legend: { type: "boolean", default: false },
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

  const style = {
    plain: values.plain,
    header: values.header,
    embedFont: values["embed-font"],
    grain: values.grain,
    legend: values.legend,
  };

  if (values.pair) {
    if (values.fix) {
      process.stderr.write(
        "ccg render: --pair already draws the repair for one spec, so it cannot be combined with --fix\n",
      );
      return 2;
    }
    if (positionals.length > 2) {
      process.stderr.write("ccg render: --pair takes one spec, or two (before, then after)\n");
      return 2;
    }
    if (!out) {
      process.stderr.write("ccg render: --pair writes two files, so it needs -o to name them\n");
      return 2;
    }

    // One spec is drawn as written and then repaired. Two are drawn as written,
    // which is how a hand revision (a guard added, say) shows up: --fix only
    // moves edges, it never adds an `expects`.
    const revised = positionals[1];
    const fenced = extname(out) === ".md";
    const before = draw(spec, format, { ...style, fix: false }, fenced);
    const after = draw(revised ?? spec, format, { ...style, fix: revised === undefined }, fenced);

    // Both are drawn before either is written, so a bad second spec leaves nothing behind.
    for (const [which, drawing] of [
      ["before", before],
      ["after", after],
    ] as const) {
      const file = pairPath(out, which);
      writeFileSync(file, drawing.text, "utf8");
      report(file, format, drawing);
    }
    return 0;
  }

  const drawing = draw(spec, format, { ...style, fix: values.fix }, extname(out ?? "") === ".md");
  if (out) {
    writeFileSync(out, drawing.text, "utf8");
    report(out, format, drawing);
  } else {
    process.stdout.write(drawing.text.endsWith("\n") ? drawing.text : `${drawing.text}\n`);
  }
  return 0;
}

interface Style {
  plain: boolean;
  fix: boolean;
  header: boolean;
  embedFont: boolean;
  grain: boolean;
  legend: boolean;
}

interface Drawing {
  text: string;
  layers: number;
  nodes: number;
}

function draw(path: string, format: Format, style: Style, fenced = false): Drawing {
  const original = loadGraph(path);
  const result = lint(original);
  const graph = style.fix ? withEdges(original, result.repairedEdges) : original;

  // Findings are read from the graph on the page. Repairing moves edges, which
  // changes how many results reach a node, so the as-written findings would
  // describe a picture that is no longer drawn.
  const shown = style.fix ? lint(graph) : result;
  const raw = shown.findings.filter((f) => f.phase === "raw");

  // Every rule has a mark (lint's `renderMarksFor` will not compile otherwise),
  // and --plain leaves all of them off.
  const found = style.plain ? NO_MARKS : renderMarksFor(raw);
  const marks: RenderMarks = { ...found, fakeEdges: style.fix ? [] : found.fakeEdges };

  return {
    text: emit(format, graph, original, marks, { ...style, fenced }),
    layers: style.fix ? result.layersAfter : result.layersBefore,
    nodes: graph.nodes.size,
  };
}

const NO_MARKS: RenderMarks = { fakeEdges: [], guardFindings: [], findingMarks: [] };

function report(file: string, format: Format, drawing: Drawing): void {
  process.stderr.write(
    `wrote ${file} — ${format}, ${drawing.layers} layers, ${drawing.nodes} nodes\n`,
  );
}

/** `out.svg` becomes `out-before.svg`. */
function pairPath(out: string, which: "before" | "after"): string {
  const ext = extname(out);
  return `${out.slice(0, out.length - ext.length)}-${which}${ext}`;
}

function emit(
  format: Format,
  graph: Graph,
  original: Graph,
  marks: RenderMarks,
  options: {
    fix: boolean;
    header: boolean;
    embedFont: boolean;
    fenced: boolean;
    grain: boolean;
    legend: boolean;
  },
): string {
  const title = options.fix ? `${original.spec.name} (repaired)` : original.spec.name;
  const legend = options.legend;

  switch (format) {
    case "mermaid":
      return renderMermaid(graph, { ...marks, fenced: options.fenced, steps: legend });
    case "excalidraw":
      return `${JSON.stringify(renderExcalidraw(layoutGraph(graph), { ...marks, steps: legend }), null, 2)}\n`;
    case "svg":
      return renderSvg(layoutGraph(graph), {
        header: options.header,
        embedFont: options.embedFont,
        grain: options.grain,
        ...marks,
        title,
        ...(legend && { steps: "legend" as const }),
      });
    case "html":
      // The numbers go on the picture; the list is HTML beside it, so it reads at any zoom.
      return wrapHtml(
        renderSvg(layoutGraph(graph), {
          header: options.header,
          embedFont: options.embedFont,
          grain: options.grain,
          ...marks,
          title,
          ...(legend && { steps: "numbers" as const }),
        }),
        { title, ...(legend && { steps: stepLegend(graph) }) },
      );
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
