// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { renderMermaid } from "../src/index.js";

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

describe("structure", () => {
  it.each(ALL)("%s declares every node and every edge exactly once", (name) => {
    const graph = fixture(name);
    const out = renderMermaid(graph);

    expect(out).toContain("flowchart TD");
    for (const node of graph.spec.nodes) {
      // The declaration line, e.g. `  checker{{"checker"}}`
      expect(out).toMatch(new RegExp(`^  ${node.id}[[({/]`, "m"));
    }
    for (const edge of graph.spec.edges) {
      expect(out).toMatch(new RegExp(`^  ${edge.from} -\\.?->`, "m"));
    }
    const arrows = [...out.matchAll(/^ {2}\w+ -\.?->/gm)];
    expect(arrows).toHaveLength(graph.spec.edges.length);
  });

  it("needs no layout pass — mermaid ranks it itself", () => {
    // renderMermaid takes a Graph, not a PositionedGraph. If that ever changes
    // this package gains a dependency it does not need.
    expect(renderMermaid.length).toBeLessThanOrEqual(2);
  });
});

describe("kind vocabulary", () => {
  it("gives each kind a distinguishable mermaid shape", () => {
    const out = renderMermaid(fixture("research-desk"));
    expect(out).toContain('plan[/"plan the angles · strong"\\]'); // split: trapezoid
    expect(out).toContain('dedupe[["dedupe by source · expects 5"]]'); // reduce: subroutine
    expect(out).toContain('skeptic_correct{{"is it correct? · strong"}}'); // verifier: hexagon
    expect(out).toContain('report(["one ranked report · strong"])'); // synthesize: stadium
    expect(out).toContain('gate{"human approves"}'); // gate: rhombus
  });

  it("classes nodes by whether they cost tokens", () => {
    const out = renderMermaid(fixture("research-desk"));
    expect(out).toContain("class dedupe,vote code;");
    expect(out).toContain("class gate human;");
    expect(out).toMatch(/class [\w,]*plan[\w,]* agent;/);
  });

  it("badges a fanOut node rather than expanding it", () => {
    const out = renderMermaid(fixture("route-auth-audit"));
    expect(out).toContain('audit["audit one route file ×20 · cheap"]');
    expect([...out.matchAll(/^ {2}audit\[/gm)]).toHaveLength(1);
  });
});

describe("count guards", () => {
  /** diamond with its checker's guard taken away, which is what lint flags as missing. */
  const unguarded = () => {
    const graph = fixture("diamond");
    return buildGraph({
      ...graph.spec,
      nodes: graph.spec.nodes.map((n) => (n.id === "checker" ? { ...n, expects: undefined } : n)),
    });
  };

  it.each(["diamond", "research-desk"] as const)("%s carries the count it declares", (name) => {
    const graph = fixture(name);
    const out = renderMermaid(graph);
    const guarded = graph.spec.nodes.filter((n) => n.expects !== undefined);
    expect(guarded.length).toBeGreaterThan(0);
    for (const node of guarded) expect(out).toContain(`· expects ${node.expects}"`);
    // A count is a declaration, not a finding: nothing is warned about.
    expect(out).not.toMatch(/^ {2}style /m);
  });

  it("draws a guard that disagrees with lint as 'N ≠ M' with a solid red outline", () => {
    const out = renderMermaid(fixture("release-session"), {
      guardFindings: [{ id: "ci", arriving: 8 }],
    });
    expect(out).toContain("· 9 ≠ 8\"");
    expect(out).toMatch(/^ {2}style ci stroke:#C4442E,stroke-width:2\.5px;$/m);
    // The style line comes after the class lines, so it wins, and it is not dashed.
    expect(out.indexOf("  style ci")).toBeGreaterThan(out.indexOf("  class "));
    expect(out.split("\n").find((l) => l.startsWith("  style ci"))).not.toContain("dasharray");
  });

  it("draws an unguarded fan-in with a red outline and a note", () => {
    const out = renderMermaid(unguarded(), { guardFindings: [{ id: "checker", arriving: 5 }] });
    expect(out).toContain('checker{{"checker · strong · no count guard"}}');
    expect(out).toMatch(/^ {2}style checker stroke:#C4442E/m);
  });

  it("draws no warn marks when nothing is passed in", () => {
    for (const out of [renderMermaid(unguarded()), renderMermaid(fixture("release-session"))]) {
      expect(out).not.toMatch(/^ {2}style /m);
      expect(out).not.toContain("no count guard");
    }
    expect(renderMermaid(fixture("release-session"))).toContain("· expects 9");
  });

  it("is deterministic with findings", () => {
    const options = { guardFindings: [{ id: "ci", arriving: 8 }] };
    expect(renderMermaid(fixture("release-session"), options)).toBe(
      renderMermaid(fixture("release-session"), options),
    );
  });
});

describe("edges", () => {
  it("labels each edge with what it carries", () => {
    expect(renderMermaid(fixture("diamond"))).toContain(
      'worker_1 -->|"claim, source, date"| checker',
    );
  });

  it("dots fake edges and styles them by index", () => {
    const out = renderMermaid(fixture("linear-chain"), {
      fakeEdges: [
        { from: "review_a", to: "review_b" },
        { from: "review_b", to: "lint_docs" },
      ],
    });
    expect(out).toContain('review_a -.->|"no data"| review_b');
    expect(out).toContain('review_b -.->|"no data"| lint_docs');
    // linkStyle is positional: the fake edges are edges 1 and 2 in the spec.
    expect(out).toContain("linkStyle 1 stroke:#C4442E");
    expect(out).toContain("linkStyle 2 stroke:#C4442E");
  });

  it("can drop the carries labels", () => {
    expect(renderMermaid(fixture("diamond"), { showCarries: false })).not.toContain('|"angle"|');
  });
});

describe("boundaries", () => {
  it("emits a subgraph per boundary, listing nodes already declared", () => {
    const out = renderMermaid(fixture("research-desk"));
    expect(out).toContain(
      [
        '  subgraph gather__boundary["gather and check · read-only"]',
        "    research",
        "    dedupe",
        "    skeptic_correct",
        "    skeptic_current",
        "    skeptic_source",
        "    vote",
        "  end",
        "  class gather__boundary boundary;",
      ].join("\n"),
    );
    expect(out).toContain(
      "  classDef boundary fill:none,stroke:#736A63,stroke-width:1.4px,stroke-dasharray:12 6,color:#736A63;",
    );
    // Declared before the subgraph, so the subgraph adds no node of its own.
    expect(out.indexOf("  research[")).toBeLessThan(out.indexOf("subgraph"));
  });

  it("emits no subgraph for a spec without a boundary", () => {
    const out = renderMermaid(fixture("diamond"));
    expect(out).not.toContain("subgraph");
    expect(out).not.toContain("classDef boundary");
  });

  it("is deterministic", () => {
    expect(renderMermaid(fixture("research-desk"))).toBe(renderMermaid(fixture("research-desk")));
  });
});

describe("options", () => {
  it("emits the handDrawn config by default and can turn it off", () => {
    expect(renderMermaid(fixture("diamond"))).toContain("look: handDrawn");
    expect(renderMermaid(fixture("diamond"), { handDrawn: false })).not.toContain("look:");
  });

  it("can fence itself for markdown", () => {
    const out = renderMermaid(fixture("diamond"), { fenced: true });
    expect(out.startsWith("```mermaid\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
  });
});

describe("who runs each step", () => {
  const review = () =>
    buildGraph({
      version: 1,
      name: "review",
      nodes: [
        { id: "write", label: "write", kind: "worker", model: "cheap", in: {}, out: { diff: "string" } },
        {
          id: "review",
          label: "review",
          kind: "verifier",
          model: "strong",
          uses: ["skill:x", "agent:reviewer"],
          in: { diff: "string" },
          out: {},
        },
      ],
      edges: [{ from: "write", to: "review", carries: ["diff"] }],
    });

  it("suffixes the tier, as the svg marks it, and leaves plain code alone", () => {
    const out = renderMermaid(fixture("research-desk"));
    expect(out).toContain('research["researcher ×5 · cheap"]');
    expect(out).toContain('dedupe[["dedupe by source · expects 5"]]');
    expect(out).toContain('gate{"human approves"}');
  });

  it("suffixes the agent a node declares, after its tier", () => {
    const out = renderMermaid(review());
    expect(out).toContain('review{{"review · strong · agent: reviewer"}}');
    expect(out).toContain('write["write · cheap"]');
  });
});

describe("escaping", () => {
  it("uses mermaid entities for characters that would break a label", () => {
    // research-desk's goal contains "<question>"; skeptics contain "?".
    const out = renderMermaid(fixture("research-desk"));
    expect(out).not.toMatch(/\["[^"]*"[^\]]*"/);
    const withAngles = renderMermaid({
      ...fixture("diamond"),
      spec: {
        ...fixture("diamond").spec,
        nodes: fixture("diamond").spec.nodes.map((n) =>
          n.id === "split" ? { ...n, label: 'a "quoted" <tag>' } : n,
        ),
      },
    });
    expect(withAngles).toContain("#quot;quoted#quot;");
    expect(withAngles).toContain("#lt;tag#gt;");
  });
});

describe("finding marks", () => {
  const HIDDEN = { rule: "HIDDEN_EDGE", between: ["draft_a", "draft_b"], file: "out/draft.md" } as const;

  it("notes each finding in the label and outlines the node in red", () => {
    const out = renderMermaid(fixture("self-grading"), {
      findingMarks: [HIDDEN, { rule: "SELF_GRADING", id: "check_own" }],
    });
    expect(out).toContain("grade the drafts · cheap · grades own work · expects 2");
    expect(out).toContain("draft section A · cheap · shares out/draft.md with draft_b");
    for (const id of ["draft_a", "draft_b", "check_own"]) {
      expect(out).toContain(`style ${id} stroke:#C4442E,stroke-width:2.5px;`);
    }
  });

  it("notes who does the work: a shared model on the verifier, a tier the wrong way round", () => {
    const out = renderMermaid(fixture("self-grading"), {
      findingMarks: [
        { rule: "SELF_GRADING", id: "check_own" },
        { rule: "MONOCULTURE", id: "check_own", tier: "cheap" },
        { rule: "TIER_MISMATCH", id: "publish", tier: "cheap" },
      ],
    });
    expect(out).toContain("grade the drafts · cheap · grades own work · cheap checks cheap · expects 2");
    expect(out).toContain("publish · strong · cheap synthesis of a fan-out");
    const agent = renderMermaid(fixture("self-grading"), { findingMarks: [{ rule: "MONOCULTURE", id: "check_own", agent: "drafter" }] });
    expect(agent).toContain("· same agent as its work: drafter");
  });

  it("joins no two writers with a link, since a link would move a node down a row", () => {
    const plain = renderMermaid(fixture("self-grading"));
    const marked = renderMermaid(fixture("self-grading"), { findingMarks: [HIDDEN] });
    const links = (s: string) => s.split("\n").filter((l) => /-->|-\.->|~~~|---/.test(l));
    expect(links(marked)).toEqual(links(plain));
  });
});
