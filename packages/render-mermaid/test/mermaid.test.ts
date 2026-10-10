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
    expect(out).toContain('plan[/"plan the angles"\\]'); // split: trapezoid
    expect(out).toContain('dedupe[["dedupe by source · expects 5"]]'); // reduce: subroutine
    expect(out).toContain('skeptic_correct{{"is it correct?"}}'); // verifier: hexagon
    expect(out).toContain('report(["one ranked report"])'); // synthesize: stadium
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
    expect(out).toContain('audit["audit one route file ×20"]');
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
    expect(out).toContain('checker{{"checker · no count guard"}}');
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
