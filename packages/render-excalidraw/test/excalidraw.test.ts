// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { renderExcalidraw } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => layoutGraph(loadGraph(`${examples}${name}.yaml`));

const ALL = [
  "diamond",
  "research-desk",
  "route-auth-audit",
  "linear-chain",
  "self-grading",
  "wide-fanin",
] as const;

/** Keys Excalidraw requires on every element or it refuses the scene. */
const REQUIRED = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
] as const;

describe("scene envelope", () => {
  it.each(ALL)("%s produces a loadable scene", (name) => {
    const scene = renderExcalidraw(fixture(name));
    expect(scene.type).toBe("excalidraw");
    expect(scene.version).toBe(2);
    expect(scene.files).toEqual({});
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
  });

  it.each(ALL)("%s: every element carries the required keys", (name) => {
    for (const element of renderExcalidraw(fixture(name)).elements) {
      for (const key of REQUIRED) expect(element, `${element["type"]}.${key}`).toHaveProperty(key);
      expect(Number.isFinite(element["x"])).toBe(true);
      expect(Number.isFinite(element["y"])).toBe(true);
      expect(Number.isInteger(element["seed"])).toBe(true);
    }
  });

  it.each(ALL)("%s: element ids are unique", (name) => {
    const ids = renderExcalidraw(fixture(name)).elements.map((e) => e["id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("emits one box, one label and one arrow per graph element", () => {
    const positioned = fixture("diamond");
    const scene = renderExcalidraw(positioned);
    const count = (type: string) => scene.elements.filter((e) => e["type"] === type).length;

    expect(count("rectangle")).toBe(positioned.nodes.length);
    expect(count("text")).toBe(positioned.nodes.length);
    expect(count("arrow")).toBe(positioned.edges.length);
  });
});

describe("bindings — the reason this format is worth emitting", () => {
  // Dragging a node in Excalidraw should take its arrows and label with it.
  it.each(ALL)("%s: every binding points at an element that exists", (name) => {
    const scene = renderExcalidraw(fixture(name));
    const ids = new Set(scene.elements.map((e) => e["id"]));

    for (const element of scene.elements) {
      for (const bound of (element["boundElements"] ?? []) as Array<{ id: string }>) {
        expect(ids.has(bound.id), `${element["id"]} -> ${bound.id}`).toBe(true);
      }
      for (const key of ["startBinding", "endBinding"] as const) {
        const binding = element[key] as { elementId: string } | null | undefined;
        if (binding) expect(ids.has(binding.elementId), `${element["id"]}.${key}`).toBe(true);
      }
      const containerId = element["containerId"] as string | undefined;
      if (containerId) expect(ids.has(containerId)).toBe(true);
    }
  });

  it("binds each label to its box and each arrow to both ends", () => {
    const scene = renderExcalidraw(fixture("diamond"));
    const byId = new Map(scene.elements.map((e) => [e["id"] as string, e]));

    const label = byId.get("text-checker")!;
    expect(label["containerId"]).toBe("checker");
    expect(byId.get("checker")!["boundElements"]).toContainEqual({
      id: "text-checker",
      type: "text",
    });

    const arrow = scene.elements.find((e) => e["type"] === "arrow")!;
    expect(arrow["startBinding"]).toMatchObject({ elementId: "split" });
    expect(arrow["endBinding"]).toMatchObject({ elementId: "worker_1" });
  });

  it("keeps arrow points relative to the arrow's own origin", () => {
    for (const arrow of renderExcalidraw(fixture("diamond")).elements.filter(
      (e) => e["type"] === "arrow",
    )) {
      const points = arrow["points"] as Array<[number, number]>;
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points[0]).toEqual([0, 0]);
    }
  });
});

describe("styling carries the same meaning as the svg", () => {
  it("draws code-only nodes clean and agent nodes rough", () => {
    const scene = renderExcalidraw(fixture("linear-chain"));
    const byId = new Map(scene.elements.map((e) => [e["id"] as string, e]));

    expect(byId.get("collate")!["roughness"]).toBe(0);
    expect(byId.get("write_report")!["roughness"]).toBe(1);
  });

  it("dashes the human gate", () => {
    const scene = renderExcalidraw(fixture("research-desk"));
    const gate = scene.elements.find((e) => e["id"] === "gate")!;
    expect(gate["strokeStyle"]).toBe("dashed");
  });

  it("uses Virgil so the hand-drawn look survives the round trip", () => {
    for (const text of renderExcalidraw(fixture("diamond")).elements.filter(
      (e) => e["type"] === "text",
    )) {
      expect(text["fontFamily"]).toBe(1);
    }
  });

  it("badges a fanOut label", () => {
    const scene = renderExcalidraw(fixture("route-auth-audit"));
    const label = scene.elements.find((e) => e["id"] === "text-audit")!;
    expect(label["text"]).toBe("audit one route file ×20 · cheap");
  });

  it("carries the tier and the agent in the label, and nothing for plain code", () => {
    const desk = renderExcalidraw(fixture("research-desk"));
    const text = (scene: typeof desk, id: string) => scene.elements.find((e) => e["id"] === `text-${id}`)!["text"];
    expect(text(desk, "plan")).toBe("plan the angles · strong");
    expect(text(desk, "dedupe")).toBe("dedupe by source · expects 5");
    expect(text(desk, "gate")).toBe("human approves");

    const review = renderExcalidraw(
      layoutGraph(
        buildGraph({
          version: 1,
          name: "review",
          nodes: [
            { id: "review", label: "review", kind: "verifier", model: "strong", uses: ["agent:reviewer"], in: {}, out: {} },
          ],
          edges: [],
        }),
      ),
    );
    expect(text(review, "review")).toBe("review · strong · agent: reviewer");
  });

  it("reddens and dashes fake edges", () => {
    const scene = renderExcalidraw(fixture("linear-chain"), {
      fakeEdges: [{ from: "review_a", to: "review_b" }],
    });
    const fake = scene.elements.filter(
      (e) => e["type"] === "arrow" && e["strokeStyle"] === "dashed",
    );
    expect(fake).toHaveLength(1);
    expect(fake[0]!["strokeColor"]).toBe("#c4442e");
  });
});

describe("count guards", () => {
  /** diamond with its checker's guard taken away, which is what lint flags as missing. */
  const unguarded = () => {
    const graph = loadGraph(`${examples}diamond.yaml`);
    return layoutGraph(
      buildGraph({
        ...graph.spec,
        nodes: graph.spec.nodes.map((n) => (n.id === "checker" ? { ...n, expects: undefined } : n)),
      }),
    );
  };
  const find = (scene: ReturnType<typeof renderExcalidraw>, id: string) =>
    scene.elements.find((e) => e["id"] === id);

  it.each(["diamond", "research-desk"] as const)("%s carries the count it declares", (name) => {
    const positioned = fixture(name);
    const scene = renderExcalidraw(positioned);
    const guarded = positioned.nodes.filter((n) => n.node.expects !== undefined);
    expect(guarded.length).toBeGreaterThan(0);
    for (const { node } of guarded) {
      expect(find(scene, `text-${node.id}`)!["text"]).toContain(`· expects ${node.expects}`);
    }
    // A count is a declaration, not a finding: nothing is warned about.
    expect(scene.elements.filter((e) => String(e["id"]).startsWith("halo-"))).toHaveLength(0);
    expect(scene.elements.filter((e) => e["strokeColor"] === "#c4442e")).toHaveLength(0);
  });

  it("draws a guard that disagrees with lint as 'N ≠ M', a red box and a solid halo", () => {
    const scene = renderExcalidraw(fixture("release-session"), {
      guardFindings: [{ id: "ci", arriving: 8 }],
    });
    expect(find(scene, "text-ci")!["text"]).toContain("· 9 ≠ 8");
    expect(find(scene, "ci")!["strokeColor"]).toBe("#c4442e");
    const halo = find(scene, "halo-ci")!;
    expect(halo["strokeColor"]).toBe("#c4442e");
    // Dashed already means a human gate in this scene, so a finding stays solid.
    expect(halo["strokeStyle"]).toBe("solid");
    // The halo is behind the box and bound to nothing, so dragging the box leaves no ghost arrows.
    expect(scene.elements.indexOf(halo)).toBeLessThan(scene.elements.indexOf(find(scene, "ci")!));
    expect(halo["boundElements"]).toEqual([]);
  });

  it("draws an unguarded fan-in with a red box, a halo and a note", () => {
    const scene = renderExcalidraw(unguarded(), { guardFindings: [{ id: "checker", arriving: 5 }] });
    expect(find(scene, "text-checker")!["text"]).toBe("checker · strong · no count guard");
    expect(find(scene, "checker")!["strokeColor"]).toBe("#c4442e");
    expect(find(scene, "halo-checker")).toBeDefined();
  });

  it("draws no warn marks when nothing is passed in", () => {
    for (const scene of [renderExcalidraw(unguarded()), renderExcalidraw(fixture("release-session"))]) {
      expect(scene.elements.filter((e) => String(e["id"]).startsWith("halo-"))).toHaveLength(0);
    }
    expect(find(renderExcalidraw(fixture("release-session")), "text-ci")!["text"]).toContain(
      "· expects 9",
    );
  });

  it("is deterministic with findings", () => {
    const options = { guardFindings: [{ id: "ci", arriving: 8 }] };
    const positioned = fixture("release-session");
    expect(JSON.stringify(renderExcalidraw(positioned, options))).toBe(
      JSON.stringify(renderExcalidraw(positioned, options)),
    );
  });
});

describe("boundaries", () => {
  const scene = renderExcalidraw(fixture("research-desk"));
  const byId = new Map(scene.elements.map((e) => [e["id"] as string, e]));

  it("draws a dashed rectangle behind the members, before any of them", () => {
    const region = byId.get("boundary-gather-0")!;
    expect(region["type"]).toBe("rectangle");
    expect(region["strokeStyle"]).toBe("dashed");
    expect(region["backgroundColor"]).toBe("transparent");
    const ids = scene.elements.map((e) => e["id"]);
    expect(ids.indexOf("boundary-gather-0")).toBeLessThan(ids.indexOf("research"));
  });

  it("groups the region, its caption and every member box and label", () => {
    const grouped = scene.elements.filter((e) => (e["groupIds"] as string[]).includes("boundary-gather")).map((e) => e["id"]);
    expect(grouped).toEqual(
      expect.arrayContaining(["boundary-gather-0", "boundary-gather-0-label", "research", "text-research", "vote", "text-vote"]),
    );
    expect(grouped).not.toContain("report");
    expect(byId.get("boundary-gather-0-label")!["text"]).toBe("gather and check · read-only");
  });
});

describe("determinism", () => {
  it("produces an identical file for identical input", () => {
    const positioned = fixture("research-desk");
    expect(JSON.stringify(renderExcalidraw(positioned))).toBe(
      JSON.stringify(renderExcalidraw(positioned)),
    );
  });
});

describe("finding marks", () => {
  const HIDDEN = { rule: "HIDDEN_EDGE", between: ["draft_a", "draft_b"], file: "out/draft.md" } as const;
  const scene = () =>
    renderExcalidraw(fixture("self-grading"), {
      findingMarks: [HIDDEN, { rule: "SELF_GRADING", id: "check_own" }],
    });
  const byId = (id: string) => scene().elements.find((e) => e["id"] === id)!;

  it("joins two writers of one file with a thin solid red line, bound to nothing, and names the file", () => {
    const line = byId("link-draft_a~draft_b");
    expect(line["type"]).toBe("line");
    expect(line["strokeColor"]).toBe("#c4442e");
    expect(line["strokeStyle"]).toBe("solid");
    expect(line["startBinding"]).toBeNull();
    expect(byId("link-label-draft_a~draft_b")["text"]).toBe("draft.md");
    expect(byId("halo-draft_a")).toBeDefined();
    expect(byId("halo-draft_b")).toBeDefined();
  });

  it("rings who does the work and notes it after the shared context", () => {
    const marked = renderExcalidraw(fixture("self-grading"), {
      findingMarks: [
        { rule: "MONOCULTURE", id: "check_own", tier: "cheap" },
        { rule: "SELF_GRADING", id: "check_own" },
        { rule: "TIER_MISMATCH", id: "draft_a", tier: "strong" },
      ],
    });
    const text = JSON.stringify(marked);
    expect(text).toContain("· grades own work · cheap checks cheap");
    expect(text).toContain("· strong per item");
    expect(marked.elements.some((e) => e["id"] === "halo-draft_a")).toBe(true);
  });

  it("rings a node finding and notes it in the label", () => {
    expect(byId("halo-check_own")).toBeDefined();
    expect(byId("text-check_own")["text"]).toBe("grade the drafts · cheap · grades own work · expects 2");
  });

  it("is byte-identical across renders", () => {
    expect(JSON.stringify(scene())).toBe(JSON.stringify(scene()));
  });
});

describe("urgency", () => {
  it("notes it in the label, on the urgent step and each step it pulls forward", () => {
    const graph = loadGraph(`${examples}research-desk.yaml`);
    const scene = renderExcalidraw(
      layoutGraph(
        buildGraph({
          ...graph.spec,
          nodes: graph.spec.nodes.map((n) =>
            n.id === "skeptic_source" ? { ...n, priority: "urgent" as const, prioritySetBy: "on-call" } : n,
          ),
        }),
      ),
    );
    const text = (id: string) => scene.elements.find((e) => e["id"] === `text-${id}`)!["text"];
    expect(text("skeptic_source")).toBe("is the source real? · strong · urgent, set by on-call");
    expect(text("dedupe")).toBe("dedupe by source · urgent, needed by skeptic_source · expects 5");
    expect(text("skeptic_correct")).toBe("is it correct? · strong");
  });
});

describe("step numbers", () => {
  const texts = (scene: ReturnType<typeof renderExcalidraw>) =>
    scene.elements.filter((e) => e["type"] === "text").map((e) => e["text"] as string);

  it("are off by default", () => {
    expect(texts(renderExcalidraw(fixture("diamond"))).join("\n")).not.toContain("step by step");
  });

  it("lead each label inside its box, and the legend sits under the drawing", () => {
    const positioned = fixture("wide-fanin");
    const scene = renderExcalidraw(positioned, { steps: true });
    expect(texts(scene)).toContain("2 · read one page ×200 · cheap");
    const legend = scene.elements.find((e) => e["id"] === "legend-steps")!;
    expect(legend["y"]).toBe(positioned.height);
    expect(legend["text"]).toBe(
      [
        "one run, step by step",
        "1  list every page · takes root; gives page",
        "2  read one page · one per page, up to 200; takes page; gives text",
        "3  one big summary · takes text; gives summary",
      ].join("\n"),
    );
    for (const key of REQUIRED) expect(legend).toHaveProperty(key);
  });
});
