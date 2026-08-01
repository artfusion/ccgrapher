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
  // The one with a finding worth keeping: `ci` declares expects: 9 and eight
  // results reach it. If ingest dropped an edge that would quietly become nine.
  "release-session",
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

/**
 * The claude-code target narrates itself with `ccg:` marker lines for a watcher
 * to read. Nothing stops that habit reaching orchestration code ingest is later
 * pointed at, and a marker is a log call, not a dependency: it has to stay inert
 * here however many node results it names.
 */
describe("ccg: marker lines are inert", () => {
  const plain = codegen(fixture("diamond"), "plain-ts");
  const marked = plain.replace(
    /^( *)(const (\w+)Result = await .*)$/gm,
    (_match: string, indent: string, statement: string, id: string) =>
      [
        `${indent}log("ccg:" + JSON.stringify({ type: "node_started", node: "${id}" }));`,
        `${indent}${statement}`,
        `${indent}log("ccg:" + JSON.stringify({ type: "node_finished", node: "${id}", output: ${id}Result }));`,
      ].join("\n"),
  );

  it("is a fair test — the source really does carry markers", () => {
    expect([...marked.matchAll(/"ccg:"/g)].length).toBeGreaterThan(1);
  });

  it("reads back the same spec, marked or not", () => {
    const { spec, warnings } = ingest(marked);

    expect(warnings).toEqual([]);
    expect(spec).toEqual(fixture("diamond").spec);
  });
});

// This source was not generated, but it does follow the `<id>Result` naming
// codegen emits. It has to keep reading cleanly now that edges come from
// dataflow: the convention is one shape among many, not a shape that was lost.
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
 * Styles a person actually writes. None of these name a variable `<id>Result`,
 * and every one of them used to come back as four nodes and no edges — a graph
 * that lints clean because it says nothing.
 *
 * The edge has to come from the value reaching the next call, whatever the
 * binding holding it is called.
 */
describe("styles a person actually writes", () => {
  const nodes = `
export interface AIn { url: string; }
export interface AOut { brief: string; }
export interface BIn { brief: string; }
export interface BOut { done: boolean; }

/** step a — split, plain code. */
export async function a(input: AIn): Promise<AOut> {
  void input;
  throw new Error("todo");
}

/** step b — worker. */
export async function b(input: BIn): Promise<BOut> {
  void input;
  throw new Error("todo");
}
`;

  const edgeAtoB = [{ from: "a", to: "b", carries: ["brief"] }];

  it("follows a plainly named binding into the next call", () => {
    const { spec, warnings } = ingest(`${nodes}
export async function runProbe(args: AIn): Promise<unknown> {
  const brief = await a(args);
  return b(brief as unknown as BIn);
}
`);

    expect(spec.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(spec.edges).toEqual(edgeAtoB);
    expect(warnings.join(" ")).not.toContain("no dependencies");
  });

  it("follows a destructured result", () => {
    const { spec } = ingest(`${nodes}
export async function runProbe(args: AIn): Promise<unknown> {
  const { brief } = await a(args);
  return b({ brief });
}
`);

    expect(spec.edges).toEqual(edgeAtoB);
  });

  it("follows a binding through a rename", () => {
    const { spec } = ingest(`${nodes}
export async function runProbe(args: AIn): Promise<unknown> {
  const scoped = await a(args);
  const passed = scoped;
  return b(passed as unknown as BIn);
}
`);

    expect(spec.edges).toEqual(edgeAtoB);
  });

  it("reads nodes declared as exported arrow consts, runner included", () => {
    const { spec, warnings } = ingest(`
export interface AIn { url: string; }
export interface AOut { brief: string; }
export interface BIn { brief: string; }
export interface BOut { done: boolean; }

/** step a — split, plain code. */
export const a = async (input: AIn): Promise<AOut> => { void input; throw new Error("todo"); };

/** step b — worker. */
export const b = async (input: BIn): Promise<BOut> => { void input; throw new Error("todo"); };

export const runProbe = async (args: AIn): Promise<unknown> => {
  const brief = await a(args);
  return b(brief as unknown as BIn);
};
`);

    expect(spec.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(spec.nodes[0]!.kind).toBe("split");
    expect(spec.edges).toEqual(edgeAtoB);
    expect(warnings.join(" ")).not.toContain("no exported node functions");
  });

  it("takes the field named on a property access as what the edge carries", () => {
    const { spec } = ingest(`
export interface ScopeIn { url: string; }
export interface ScopeOut { brief: string; notes: string; }
export interface ReviewIn { brief: string; notes: string; }
export interface ReviewOut { verdict: string; }

/** pick the scope — split, plain code. */
export async function scope(input: ScopeIn): Promise<ScopeOut> {
  void input;
  throw new Error("todo");
}

/** review it — verifier. */
export async function reviewCode(input: ReviewIn): Promise<ReviewOut> {
  void input;
  throw new Error("todo");
}

export async function runReview(args: ScopeIn): Promise<unknown> {
  const scoped = await scope(args);
  return reviewCode({ brief: scoped.brief, notes: "" } as unknown as ReviewIn);
}
`);

    // Both shapes share `notes` too, but the code only ever reads `brief`, and
    // what the code does outranks what the types happen to have in common.
    expect(spec.edges).toEqual([{ from: "scope", to: "reviewCode", carries: ["brief"] }]);
  });

  it("reads a hand-written Promise.all wave, naturally named", () => {
    const { spec, warnings } = ingest(`
export interface SplitIn { url: string; }
export interface SplitOut { brief: string; }
export interface LeftIn { brief: string; }
export interface LeftOut { left: boolean; }
export interface RightIn { brief: string; }
export interface RightOut { right: boolean; }
export interface JoinIn { left: boolean; right: boolean; }
export interface JoinOut { ok: boolean; }

/** split it — split, plain code. */
export async function split(input: SplitIn): Promise<SplitOut> {
  void input;
  throw new Error("todo");
}

/** left — worker. */
export async function left(input: LeftIn): Promise<LeftOut> {
  void input;
  throw new Error("todo");
}

/** right — worker. */
export async function right(input: RightIn): Promise<RightOut> {
  void input;
  throw new Error("todo");
}

/** join — gate. */
export async function join(input: JoinIn): Promise<JoinOut> {
  void input;
  throw new Error("todo");
}

export async function runWave(args: SplitIn): Promise<unknown> {
  const brief = await split(args);
  const [first, second] = await Promise.all([
    left(brief as unknown as LeftIn),
    right(brief as unknown as RightIn),
  ]);
  return join({ ...first, ...second } as unknown as JoinIn);
}
`);

    expect(warnings.join(" ")).not.toContain("no dependencies");
    expect(spec.edges).toEqual([
      { from: "split", to: "left", carries: ["brief"] },
      { from: "split", to: "right", carries: ["brief"] },
      { from: "left", to: "join", carries: ["left"] },
      { from: "right", to: "join", carries: ["right"] },
    ]);

    const { rank, layerCount } = rankGraph(buildGraph(spec));
    expect(layerCount).toBe(3);
    expect(rank.get("left")).toBe(1);
    expect(rank.get("right")).toBe(1);
  });

  it("reads a hand-written fan-out over a mapped list", () => {
    const { spec } = ingest(`
export interface ListIn { url: string; }
export interface ListOut { file: string; } // path
export interface AuditIn { file: string; } // path
export interface AuditOut { finding: string; }

/** list the files — split, plain code. */
export async function listFiles(input: ListIn): Promise<ListOut> {
  void input;
  throw new Error("todo");
}

/** audit one file — worker. Runs once per file. */
export async function audit(input: AuditIn): Promise<AuditOut> {
  void input;
  throw new Error("todo");
}

export async function runAudit(args: ListIn): Promise<unknown> {
  const listing = await listFiles(args);
  const files = Array.isArray(listing) ? listing : [listing];
  return Promise.all(files.map((file) => audit(file as unknown as AuditIn)));
}
`);

    expect(spec.edges).toEqual([{ from: "listFiles", to: "audit", carries: ["file"] }]);
  });
});

describe("degrades honestly", () => {
  it("warns rather than throwing on something that is not orchestration code", () => {
    const { spec, warnings } = ingest("export const x = 1;\n");
    expect(spec.nodes).toEqual([]);
    expect(warnings.join(" ")).toContain("no exported node functions");
  });

  // The dangerous shape: nodes parse, the runner parses, and the result really
  // does reach the second step — but it goes through a mutable bag, so there is
  // no binding to follow. Guessing an edge here would be guessing; the honest
  // answer is to recover nothing and say so, because a graph with no edges
  // lints clean and plans as one wave, which is flattering and wrong.
  const throughAMutableBag = `
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
  const bag: Record<string, unknown> = {};
  bag.scoped = await scope(args);
  return report(bag.scoped as unknown as ReportIn);
}
`;

  it("warns when it finds nodes but recovers no dependencies", () => {
    const { spec, warnings } = ingest(throughAMutableBag);

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
