// SPDX-License-Identifier: Apache-2.0
import { routeLinks, type PositionedGraph } from "@ccgrapher/layout";
import { markWidth } from "./marks.js";
import type { Theme } from "./theme.js";

/**
 * Finding marks: what each lint rule looks like on the page. The linter decides
 * what is wrong (`renderMarksFor` in `@ccgrapher/lint` builds these); this module
 * only decides how it looks. Fake edges and count guards predate it and keep
 * their own options.
 *
 * A node finding is a ring round the node (`renderFindingHalo`) and a caption in
 * the bottom-left slot. The slot holds one caption, so when a node has several
 * findings the caption names the first in rule order (the linter's own order,
 * most severe first) and counts the rest: `no repo +1`. Each caption has a
 * long and a short form, and the longest that fits beside the bottom-right mark
 * is used. The node group lists every rule it carries in `data-findings`.
 *
 * Two concurrent writers of one file are joined by a thin solid line labelled
 * with the file, routed by `routeLinks` round the boxes, never through them.
 * Solid because dashes mean structure here; thin and crisp so it never reads as
 * an edge, which is rough and orange and has a head.
 */
export type FindingMark =
  | { readonly rule: "MISSING_INPUT"; readonly id: string; readonly field: string }
  | { readonly rule: "SELF_GRADING"; readonly id: string }
  | { readonly rule: "CONTEXT_COLLAPSE"; readonly id: string; readonly arriving: number }
  | { readonly rule: "HIDDEN_EDGE"; readonly between: readonly [string, string]; readonly file: string };

/** The rules a node can carry, in the linter's order. */
const NODE_RULES = ["MISSING_INPUT", "HIDDEN_EDGE", "SELF_GRADING", "CONTEXT_COLLAPSE", "SILENT_FAILURE"] as const;
type NodeRule = (typeof NODE_RULES)[number];

export interface NodeFindings {
  /** Every rule the node carries, in rule order. */
  readonly rules: readonly NodeRule[];
  /** Caption candidates, one list of forms (longest first) per captioned finding, in rule order. */
  readonly captions: ReadonlyArray<readonly string[]>;
}

/**
 * What one node carries. `guard` is the count-guard finding already worked out
 * from `guardFindings`; a missing guard captions, a wrong one is drawn bottom
 * right instead and so adds no caption.
 */
export function findingsOn(
  id: string,
  marks: readonly FindingMark[],
  guard: "missing" | "mismatch" | undefined,
): NodeFindings {
  const entries: Array<{ rule: NodeRule; forms?: string[] }> = [];
  for (const m of marks) {
    switch (m.rule) {
      case "MISSING_INPUT":
        if (m.id === id) entries.push({ rule: m.rule, forms: [`no ${shorten(m.field, 14)}`, `no ${shorten(m.field, 7)}`, "no input"] });
        break;
      case "SELF_GRADING":
        if (m.id === id) entries.push({ rule: m.rule, forms: ["grades own work", "self-graded"] });
        break;
      case "CONTEXT_COLLAPSE":
        if (m.id === id) entries.push({ rule: m.rule, forms: [`${m.arriving} in, no reduce`, `${m.arriving} raw in`] });
        break;
      case "HIDDEN_EDGE":
        if (m.between.includes(id)) entries.push({ rule: m.rule });
        break;
    }
  }
  if (guard) {
    entries.push(guard === "missing" ? { rule: "SILENT_FAILURE", forms: ["no count guard", "no guard"] } : { rule: "SILENT_FAILURE" });
  }

  // Stable, so findings of one rule keep the order they were found in.
  const ordered = [...entries].sort((a, b) => NODE_RULES.indexOf(a.rule) - NODE_RULES.indexOf(b.rule));
  return {
    rules: NODE_RULES.filter((rule) => ordered.some((e) => e.rule === rule)),
    captions: ordered.flatMap((e) => (e.forms ? [e.forms] : [])),
  };
}

/** The one caption: the first finding's longest form that fits, and a count of the rest. */
export function fitCaption(captions: ReadonlyArray<readonly string[]>, room: number): string | undefined {
  const [head, ...rest] = captions;
  if (!head || head.length === 0) return undefined;
  const more = rest.length > 0 ? ` +${rest.length}` : "";
  const fits = head.find((form) => markWidth("bottom-left", form + more) <= room);
  return (fits ?? head[head.length - 1]!) + more;
}

/** The lines between concurrent writers of one file, one per pair, drawn over the nodes. */
export function renderSharedWrites(
  positioned: PositionedGraph,
  marks: readonly FindingMark[],
  theme: Theme,
): string[] {
  // One line per pair, however many files they share.
  const pairs = new Map<string, { between: readonly [string, string]; files: string[] }>();
  for (const m of marks) {
    if (m.rule !== "HIDDEN_EDGE") continue;
    const key = [...m.between].sort().join("~");
    const entry = pairs.get(key) ?? { between: m.between, files: [] };
    if (!entry.files.includes(m.file)) entry.files.push(m.file);
    pairs.set(key, entry);
  }
  const routes = routeLinks(
    positioned,
    [...pairs.values()].map((e) => e.between),
  );

  return routes.map((route) => {
    const files = pairs.get([...route.between].sort().join("~"))!.files;
    const label = `${shorten(basename(files[0]!), 16)}${files.length > 1 ? ` +${files.length - 1}` : ""}`;
    const d = route.points.map((p, k) => `${k === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join(" ");
    const ends = [route.points[0]!, route.points[route.points.length - 1]!]
      .map((p) => `<circle cx="${r(p.x)}" cy="${r(p.y)}" r="2.6" fill="${theme.danger}"/>`)
      .join("");
    return [
      `<g data-link="${escapeAttr(route.between.join("~"))}" data-finding="HIDDEN_EDGE" data-writes="${escapeAttr(files.join(", "))}">`,
      `<path d="${d}" fill="none" stroke="${theme.danger}" stroke-width="1.5" stroke-linejoin="round"/>`,
      ends,
      // A paper-coloured outline keeps the label legible where an edge crosses the lane.
      `<text x="${r(route.label.x)}" y="${r(route.label.y - 5)}" font-size="13" fill="${theme.dangerInk}" text-anchor="middle" stroke="${theme.paper}" stroke-width="3" paint-order="stroke">${escapeText(label)}</text>`,
      `</g>`,
    ].join("");
  });
}

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** Cut to `max` characters, with an ellipsis (which Caveat has) where it was cut. */
const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const r = (n: number) => Number(n.toFixed(2));

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");
