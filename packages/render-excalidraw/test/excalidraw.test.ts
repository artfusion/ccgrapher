// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
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
    expect(label["text"]).toBe("audit one route file ×20");
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

describe("determinism", () => {
  it("produces an identical file for identical input", () => {
    const positioned = fixture("research-desk");
    expect(JSON.stringify(renderExcalidraw(positioned))).toBe(
      JSON.stringify(renderExcalidraw(positioned)),
    );
  });
});
