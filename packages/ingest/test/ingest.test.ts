// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { codegen } from "@ccgrapher/codegen";
import { buildGraph, rankGraph, type WorkflowSpec } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { descriptorFor, ingest, parseTraits } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);

const ALL = [
  "diamond",
  "research-desk",
  "route-auth-audit",
  "linear-chain",
  "self-grading",
  "wide-fanin",
] as const;

const roundTrip = (name: string) => ingest(codegen(fixture(name), "plain-ts"));

describe("round trip — spec -> codegen -> ingest -> spec", () => {
  it.each(ALL)("%s comes back identical", (name) => {
    const original: WorkflowSpec = fixture(name).spec;
    const { spec, warnings } = roundTrip(name);

    expect(warnings).toEqual([]);
    expect(spec).toEqual(original);
  });

  it.each(ALL)("%s: the recovered graph ranks the same", (name) => {
    const before = rankGraph(fixture(name));
    const after = rankGraph(buildGraph(roundTrip(name).spec));

    expect(after.layerCount).toBe(before.layerCount);
    expect([...after.rank.entries()].sort()).toEqual([...before.rank.entries()].sort());
  });
});

describe("what survives the trip", () => {
  it("keeps descriptors that TypeScript would flatten to string", () => {
    const { spec } = roundTrip("diamond");
    const worker = spec.nodes.find((n) => n.id === "worker_1")!;
    expect(worker.out).toEqual({ claim: "string", source: "url", date: "YYYY-MM-DD" });
  });

  it("keeps kind, model tier and fresh context", () => {
    const { spec } = roundTrip("diamond");
    const checker = spec.nodes.find((n) => n.id === "checker")!;
    expect(checker.kind).toBe("verifier");
    expect(checker.model).toBe("strong");
    expect(checker.freshContext).toBe(true);
    expect(checker.expects).toBe(5);
  });

  it("keeps model: null on a code-only node", () => {
    const { spec } = roundTrip("linear-chain");
    expect(spec.nodes.find((n) => n.id === "collate")!.model).toBeNull();
  });

  it("keeps fanOut, its cap, and the worktree flag", () => {
    const { spec } = roundTrip("route-auth-audit");
    const audit = spec.nodes.find((n) => n.id === "audit")!;
    expect(audit.fanOut).toEqual({ over: "file", cap: 20 });
    expect(audit.worktree).toBe(true);
  });

  it("keeps writes, which is what the hidden-edge rule needs", () => {
    const { spec } = roundTrip("linear-chain");
    expect(spec.nodes.find((n) => n.id === "review_a")!.writes).toEqual(["notes/findings.md"]);
  });

  it("recovers an empty carries — a fake edge stays fake", () => {
    const { spec } = roundTrip("linear-chain");
    const fake = spec.edges.find((e) => e.from === "review_a" && e.to === "review_b")!;
    expect(fake.carries).toEqual([]);
  });

  it("recovers the fan-in edges from one Object.assign", () => {
    const { spec } = roundTrip("linear-chain");
    const intoCollate = spec.edges.filter((e) => e.to === "collate").map((e) => e.from);
    expect(intoCollate).toEqual(["review_a", "review_b", "lint_docs"]);
  });

  it("recovers the fan-out edges from one Promise.all", () => {
    const { spec } = roundTrip("diamond");
    const fromSplit = spec.edges.filter((e) => e.from === "split").map((e) => e.to);
    expect(fromSplit).toEqual(["worker_1", "worker_2", "worker_3", "worker_4", "worker_5"]);
  });
});

// Named for what it actually covers. This source was not generated, but it does
// follow the `<id>Result` naming codegen emits — which is the only shape edge
// recovery currently understands. `styles it cannot read yet`, below, holds the
// cases this block was once mistaken for covering.
describe("code we did not generate, written in the Result convention", () => {
  // The point of reading code back is auditing a workflow nobody drew.
  const handWritten = `
// Spec: nightly
// Goal: nightly release checks

export interface FetchIn { ref: string; }
export interface FetchOut { tree: string; } // path

/** fetch the tree — split, plain code. */
export async function fetchTree(input: FetchIn): Promise<FetchOut> {
  void input;
  throw new Error("todo");
}

export interface UnitIn { tree: string; }
export interface UnitOut { unit: boolean; }

/** run unit tests — worker, model: cheap. */
export async function unit(input: UnitIn): Promise<UnitOut> {
  void input;
  throw new Error("todo");
}

export interface LintIn { tree: string; }
export interface LintOut { lint: boolean; }

/** run the linter — worker, model: cheap. */
export async function lintStep(input: LintIn): Promise<LintOut> {
  void input;
  throw new Error("todo");
}

export interface GateIn { unit: boolean; lint: boolean; }
export interface GateOut { ok: boolean; }

/** release gate — gate. */
export async function gate(input: GateIn): Promise<GateOut> {
  void input;
  throw new Error("todo");
}

export async function runNightly(args: FetchIn): Promise<unknown> {
  const fetchTreeResult = await fetchTree(args);
  const [unitResult, lintStepResult] = await Promise.all([
    unit(fetchTreeResult as unknown as UnitIn),
    lintStep(fetchTreeResult as unknown as LintIn),
  ]);
  const gateResult = await gate(
    Object.assign({}, unitResult, lintStepResult) as unknown as GateIn,
  );
  return { gate: gateResult };
}
`;

  const { spec, warnings } = ingest(handWritten);

  it("reads it without complaint", () => {
    expect(warnings).toEqual([]);
    expect(spec.name).toBe("nightly");
    expect(spec.goal).toBe("nightly release checks");
  });

  it("finds every node and every dependency", () => {
    expect(spec.nodes.map((n) => n.id)).toEqual(["fetchTree", "unit", "lintStep", "gate"]);
    expect(spec.edges).toEqual([
      { from: "fetchTree", to: "unit", carries: ["tree"] },
      { from: "fetchTree", to: "lintStep", carries: ["tree"] },
      { from: "unit", to: "gate", carries: ["unit"] },
      { from: "lintStep", to: "gate", carries: ["lint"] },
    ]);
  });

  it("sees that the two test steps are genuinely concurrent", () => {
    const { rank, layerCount } = rankGraph(buildGraph(spec));
    expect(layerCount).toBe(3);
    expect(rank.get("unit")).toBe(1);
    expect(rank.get("lintStep")).toBe(1);
  });
});

/**
 * Styles a person actually writes that edge recovery cannot read yet. These are
 * characterisation tests, not endorsements — they pin current behaviour so the
 * limits are visible in the suite rather than discovered in someone's repo.
 *
 * When edges are recovered from dataflow instead of from variable names, these
 * should start failing. Rewrite them as real expectations then; do not relax
 * them.
 */
describe("styles it cannot read yet", () => {
  const nodes = `
export interface AIn { url: string; }
export interface AOut { brief: string; }
export interface BIn { brief: string; }
export interface BOut { done: boolean; }
`;

  it("loses every dependency when the runner destructures the result", () => {
    const { spec, warnings } = ingest(`${nodes}
/** step a — split, plain code. */
export async function a(input: AIn): Promise<AOut> { void input; throw new Error("todo"); }

/** step b — worker. */
export async function b(input: BIn): Promise<BOut> { void input; throw new Error("todo"); }

export async function runProbe(args: AIn): Promise<unknown> {
  const { brief } = await a(args);
  return b({ brief });
}
`);

    expect(spec.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(spec.edges).toEqual([]);
    // b genuinely reads what a produced. Without the warning this graph lints
    // clean and plans as a single wave.
    expect(warnings.join(" ")).toContain("no dependencies");
  });

  it("does not see nodes declared as exported arrow consts", () => {
    const { spec, warnings } = ingest(`${nodes}
/** step a — split, plain code. */
export const a = async (input: AIn): Promise<AOut> => { void input; throw new Error("todo"); };

export async function runProbe(args: AIn): Promise<unknown> {
  const aResult = await a(args);
  return aResult;
}
`);

    expect(spec.nodes).toEqual([]);
    expect(warnings.join(" ")).toContain("no exported node functions");
  });
});

describe("degrades honestly", () => {
  it("warns rather than throwing on something that is not orchestration code", () => {
    const { spec, warnings } = ingest("export const x = 1;\n");
    expect(spec.nodes).toEqual([]);
    expect(warnings.join(" ")).toContain("no exported node functions");
  });

  // The dangerous shape: nodes parse, the runner parses, but the awaits use
  // natural variable names, so no edge is recovered. The result lints clean and
  // plans as one wave — the most flattering answer, and wrong.
  it("warns when it finds nodes but recovers no dependencies", () => {
    const naturallyNamed = `
export interface ScopeIn { url: string; }
export interface ScopeOut { brief: string; }
export interface ReportIn { brief: string; }
export interface ReportOut { report: string; }

/** pick the scope — split, plain code. */
export async function scope(input: ScopeIn): Promise<ScopeOut> {
  void input;
  throw new Error("todo");
}

/** write it up — synthesize. */
export async function report(input: ReportIn): Promise<ReportOut> {
  void input;
  throw new Error("todo");
}

export async function runIt(args: ScopeIn): Promise<unknown> {
  const brief = await scope(args);
  return report(brief as unknown as ReportIn);
}
`;
    const { spec, warnings } = ingest(naturallyNamed);

    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges).toEqual([]);
    expect(warnings.join(" ")).toContain("no dependencies");
  });

  it("stays quiet when the dependencies are genuinely there", () => {
    expect(roundTrip("linear-chain").warnings).toEqual([]);
  });

  it("warns when the spec name was not recorded", () => {
    const source = codegen(fixture("diamond"), "plain-ts", { banner: false });
    const { warnings, spec } = ingest(source);
    expect(warnings.join(" ")).toContain("spec name not recorded");
    expect(spec.name).toBe("diamond");
  });
});

describe("parsers", () => {
  it("reads a trait list", () => {
    expect(
      parseTraits(
        "audit one route file — worker, model: cheap, isolated worktree, expects 20. Runs once per file, capped at 20.",
        "audit",
      ),
    ).toEqual({
      label: "audit one route file",
      kind: "worker",
      model: "cheap",
      worktree: true,
      expects: 20,
      fanOut: { over: "file", cap: 20 },
    });
  });

  it("prefers a trailing comment over the flattened type", () => {
    expect(descriptorFor("string", "// YYYY-MM-DD")).toBe("YYYY-MM-DD");
    expect(descriptorFor("string")).toBe("string");
    expect(descriptorFor("string[]")).toBe("string[]");
    expect(descriptorFor('"keep" | "drop"')).toBe("keep|drop");
    expect(descriptorFor("Record<string, unknown>")).toBe("object");
  });
});
