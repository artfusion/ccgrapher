// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke tests for `Editor`, the one component every overlay/model unit test
 * (bridge.test.ts, capability.test.ts, heat.test.ts, overlay.test.ts) stops
 * short of: they all pin what `buildModel`/the overlays *produce*, never that
 * the component actually wires that output to the screen.
 *
 * `./canvas/canvas` is mocked out — it pulls in `@joint/react`, which owns a
 * real SVG paper and is its own, heavier, testing problem. What is checked
 * here is Editor's own logic: which pane it shows for a given spec, and that
 * the live-run status text a person actually reads reaches the DOM.
 */

import { buildGraph, parseSpec } from "@ccgrapher/core";
import { lint } from "@ccgrapher/lint";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModel } from "../lib/graph-model";
import { FIXTURES } from "../lib/fixtures";
import { encodeSpecFragment } from "../lib/viewer-link";
import type { CCEdge, CCNode } from "../lib/view-model";
import type { EdgeGestures } from "../app/canvas/canvas";

// Each node is a button that selects it, the way a click on its card does,
// and carries the parts of its `data` the inspector tests read back.
// The real canvas frames the graph once, when it mounts, so counting mounts is
// how these tests see whether an edit kept the reader's pan and zoom.
const canvasMounts = vi.hoisted(() => ({ count: 0 }));
// The edge gestures the editor last handed the canvas: the tests below call
// them the way the real canvas does when a link is drawn, dragged or deleted.
const canvasGestures = vi.hoisted(() => ({ current: undefined as EdgeGestures | undefined }));

vi.mock("../app/canvas/canvas", async () => {
  const { useEffect } = await import("react");
  return {
  Canvas: function CanvasMock({
    nodes,
    onSelect,
    gestures,
  }: {
    nodes: readonly CCNode[];
    edges: readonly CCEdge[];
    onSelect?: (id: string | undefined) => void;
    gestures?: EdgeGestures;
  }) {
    canvasGestures.current = gestures;
    useEffect(() => {
      canvasMounts.count += 1;
    }, []);
    return (
      <div data-testid="canvas-mock" data-node-count={nodes.length}>
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            data-testid={`node-${n.id}`}
            data-style={String(n.data.style)}
            data-uses={((n.data.uses as string[] | undefined) ?? []).join(" ")}
            data-selected={n.data.selected === true ? "true" : undefined}
            onClick={() => onSelect?.(n.id)}
          >
            {n.id}
          </button>
        ))}
      </div>
    );
  },
  };
});

const { Editor } = await import("../app/editor");

const BROKEN_SPEC = "not: [valid, yaml";

const NO_RUNS = { runs: [] };
const ONE_RUN = { runs: [{ id: "some-run", bytes: 10, modifiedAt: "2024-01-01T00:00:00Z" }] };

function mockRunsEndpoint(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the default fixture", () => {
  beforeEach(() => mockRunsEndpoint(NO_RUNS));

  it("hands the laid-out graph to the canvas", async () => {
    render(<Editor />);
    const canvas = await screen.findByTestId("canvas-mock");
    expect(canvas.getAttribute("data-node-count")).not.toBe("0");
    expect(screen.queryByText("spec error")).toBeNull();
  });
});

describe("a spec that fails to parse", () => {
  beforeEach(() => mockRunsEndpoint(NO_RUNS));

  it("shows the parse error over the last good picture, held inert", async () => {
    render(<Editor />);
    // Let the first (valid) render settle before breaking it, so the
    // assertion below is about the transition, not a race with mount.
    await screen.findByTestId("canvas-mock");
    const mounts = canvasMounts.count;

    // fireEvent.change rather than user-event: the spec deliberately contains
    // `[`, which user-event's keystroke DSL reads as a key-name delimiter.
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: BROKEN_SPEC } });

    expect(await screen.findByText("spec error")).toBeTruthy();
    expect(document.querySelector("pre.error")?.textContent).toMatch(/not valid YAML/);
    const host = screen.getByTestId("canvas-mock").closest(".canvas-host")!;
    expect(host.classList.contains("held")).toBe(true);
    expect(host.hasAttribute("inert")).toBe(true);

    // Fixed again: the same canvas, live again, never remounted.
    fireEvent.change(textarea, { target: { value: FIXTURES["diamond"] } });
    await waitFor(() => expect(screen.queryByText("spec error")).toBeNull());
    expect(host.classList.contains("held")).toBe(false);
    expect(canvasMounts.count).toBe(mounts);
  });

  it("has no picture to hold for a spec that was loaded broken", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // jsdom's File has no `text()`; the editor reads nothing else.
    const file = Object.assign(new File([BROKEN_SPEC], "broken.yaml"), {
      text: async () => BROKEN_SPEC,
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("spec error")).toBeTruthy();
    expect(screen.queryByTestId("canvas-mock")).toBeNull();
  });
});

describe("pan and zoom across an edit", () => {
  beforeEach(() => mockRunsEndpoint(NO_RUNS));

  it("keeps the mounted canvas through edits and the repaired toggle, and remounts on a load", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    const mounts = canvasMounts.count;

    // A typed edit that moves boxes: the chain's fake edges dropped by hand.
    const textarea = document.querySelector("textarea")!;
    const edited = FIXTURES["linear-chain"]!.replace(/.*review_a,\s+to: review_b.*\n/, "");
    expect(edited).not.toBe(FIXTURES["linear-chain"]);
    fireEvent.change(textarea, { target: { value: edited } });
    await waitFor(() => expect(textarea.value).toBe(edited));
    expect(canvasMounts.count).toBe(mounts);

    // The as-written / repaired toggle: the showcase, and still the same canvas.
    fireEvent.change(textarea, { target: { value: FIXTURES["linear-chain"] } });
    fireEvent.click(screen.getByLabelText("preview repaired"));
    fireEvent.click(screen.getByLabelText("preview repaired"));
    expect(canvasMounts.count).toBe(mounts);

    // Loading a spec is a new drawing, framed afresh.
    fireEvent.change(screen.getByDisplayValue("load an example…"), {
      target: { value: "diamond" },
    });
    await waitFor(() => expect(canvasMounts.count).toBe(mounts + 1));
  });
});

describe("the live run bar", () => {
  it("stays hidden until a trace server has answered", () => {
    mockRunsEndpoint(NO_RUNS);
    render(<Editor />);
    expect(screen.queryByLabelText("trace server URL")).toBeNull();
  });

  it("appears once the server is reachable, and reports a run it cannot stream", async () => {
    mockRunsEndpoint(ONE_RUN);
    const user = userEvent.setup();
    render(<Editor />);
    await screen.findByLabelText("trace server URL");

    // jsdom has no EventSource: picking a run must fail to *connect* rather
    // than hang, and that failure has to reach the same status text a reader
    // sees in a real browser when a stream drops — see connectRun's
    // try/catch around the EventSource constructor in lib/run-state.ts.
    const runSelect = screen.getByLabelText("run");
    await user.selectOptions(runSelect, "some-run");

    await waitFor(() => {
      const status = document.querySelector(".live-state.closed");
      expect(status).toBeTruthy();
      expect(status?.textContent).not.toBe("");
    });
  });
});

describe("a spec carried in the URL fragment", () => {
  beforeEach(() => mockRunsEndpoint(NO_RUNS));

  afterEach(() => {
    window.location.hash = "";
  });

  it("loads that spec instead of the default fixture, and enters viewer mode", async () => {
    const diamond = FIXTURES.diamond!;
    window.location.hash = `#${encodeSpecFragment(diamond)}`;

    render(<Editor />);
    const canvas = await screen.findByTestId("canvas-mock");

    const expectedNodeCount = (buildModel(diamond, false) as { nodes: unknown[] }).nodes.length;
    expect(canvas.getAttribute("data-node-count")).toBe(String(expectedNodeCount));

    // The editing surface — the example dropdown, the "open a spec" file
    // picker, and the YAML textarea — is gone; the heat-file picker and the
    // repair toggle are a different concern and stay.
    expect(screen.queryByText("load an example…")).toBeNull();
    expect(document.querySelector('input[accept*=".yaml"]')).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.getByText("preview repaired")).toBeTruthy();
  });

  it("an explicit #view=1 with no spec still enters viewer mode, on the default fixture", async () => {
    window.location.hash = "#view=1";

    render(<Editor />);
    await screen.findByTestId("canvas-mock");

    expect(screen.queryByText("load an example…")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("an ordinary load with no fragment shows the full editing surface", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");

    expect(screen.queryByText("load an example…")).not.toBeNull();
    expect(document.querySelector("textarea")).not.toBeNull();
  });

  it("has no inspector in viewer mode", async () => {
    window.location.hash = "#view=1";
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    expect(document.querySelector(".pane.inspector")).toBeNull();
  });
});

describe("the node inspector", () => {
  beforeEach(() => mockRunsEndpoint(NO_RUNS));

  /** The spec text, the source of truth everything else is checked against. */
  const yaml = () => document.querySelector<HTMLTextAreaElement>(".pane.source textarea")!.value;
  const nodeIn = (source: string, id: string) => parseSpec(source).nodes.find((n) => n.id === id)!;

  /** The rules the footer shows, against the rules lint gives for the text. */
  function expectFooterAgreesWithText() {
    const shown = [...document.querySelectorAll("footer .findings .rule")].map((el) => el.textContent);
    const linted = lint(buildGraph(parseSpec(yaml()))).findings.map((f) => f.rule);
    expect(shown).toEqual(linted);
  }

  async function select(id: string) {
    await screen.findByTestId("canvas-mock");
    fireEvent.click(screen.getByTestId(`node-${id}`));
  }

  it("opens on the step clicked, marks it, and takes focus to it", async () => {
    render(<Editor />);
    await select("collate");
    const heading = screen.getByRole("heading", { name: "collate everything" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByTestId("node-collate").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("node-setup").getAttribute("data-selected")).toBeNull();
  });

  it("can be reached without the canvas, from the step picker", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    await user.selectOptions(screen.getByLabelText("inspect"), "write_report");
    expect(screen.getByRole("heading", { name: "write the report" })).toBeTruthy();
  });

  it("changes a step's tier, and the text, the picture and the findings agree", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await select("write_report");
    expect(screen.getByTestId("node-write_report").getAttribute("data-style")).toBe("agent");

    await user.selectOptions(screen.getByLabelText("model"), "null");

    expect(nodeIn(yaml(), "write_report").model).toBeNull();
    expect(screen.getByTestId("node-write_report").getAttribute("data-style")).toBe("code");
    expectFooterAgreesWithText();
  });

  it("changes an expects, and the linter says the count no longer matches", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await select("collate");
    expect(screen.queryByText("SILENT_FAILURE")).toBeNull();

    const expects = screen.getByLabelText("expects");
    await user.clear(expects);
    await user.type(expects, "2{Enter}");

    expect(nodeIn(yaml(), "collate").expects).toBe(2);
    expect(screen.getAllByText("SILENT_FAILURE").length).toBeGreaterThan(0);
    expectFooterAgreesWithText();
  });

  it("adds a uses entry, and the card shows the capability", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await select("review_a");

    await user.type(screen.getByLabelText("add to uses"), "agent:reviewer{Enter}");

    expect(nodeIn(yaml(), "review_a").uses).toEqual(["agent:reviewer"]);
    expect(screen.getByTestId("node-review_a").getAttribute("data-uses")).toBe("agent:reviewer");
    expect(screen.getByRole("button", { name: "remove agent:reviewer from uses" })).toBeTruthy();
    expectFooterAgreesWithText();
  });

  it("refuses an invalid value with the reason, and leaves the spec alone", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await select("collate");
    const before = yaml();

    const expects = screen.getByLabelText("expects");
    await user.clear(expects);
    await user.type(expects, "-1{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("must be at least 0");
    expect(expects.getAttribute("aria-invalid")).toBe("true");
    // What was typed is still there to be corrected, and nothing was applied.
    expect((expects as HTMLInputElement).value).toBe("-1");
    expect(yaml()).toBe(before);

    await user.type(screen.getByLabelText("add to uses"), "has space{Enter}");
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join()).toMatch(
      /no commas or whitespace/,
    );
    expect(yaml()).toBe(before);
  });

  it("undoes a panel edit back to the exact text, and redoes it", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await select("write_report");
    const before = yaml();

    await user.selectOptions(screen.getByLabelText("model"), "cheap");
    const after = yaml();
    expect(after).not.toBe(before);

    await user.click(screen.getByRole("button", { name: "undo" }));
    expect(yaml()).toBe(before);
    expect(nodeIn(yaml(), "write_report").model).toBe("strong");
    expect((screen.getByLabelText("model") as HTMLSelectElement).value).toBe("strong");
    expectFooterAgreesWithText();

    await user.click(screen.getByRole("button", { name: "redo" }));
    expect(yaml()).toBe(after);
  });

  it("applies the linter's repair for a fake edge from the step's findings", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await select("review_b");
    const fakeBefore = lint(buildGraph(parseSpec(yaml()))).findings.filter(
      (f) => f.rule === "FAKE_EDGE",
    ).length;

    const panel = document.querySelector<HTMLElement>(".pane.inspector")!;
    const apply = within(panel).getAllByRole("button", { name: "apply" });
    expect(apply.length).toBeGreaterThan(0);
    await user.click(apply[0]!);

    const fakeAfter = lint(buildGraph(parseSpec(yaml()))).findings.filter(
      (f) => f.rule === "FAKE_EDGE",
    ).length;
    expect(fakeAfter).toBe(fakeBefore - 1);
    expectFooterAgreesWithText();
  });

  it("follows the text: an edit typed there shows in the panel", async () => {
    render(<Editor />);
    await select("collate");
    const textarea = document.querySelector<HTMLTextAreaElement>(".pane.source textarea")!;
    fireEvent.change(textarea, { target: { value: yaml().replace("expects: 3", "expects: 4") } });
    expect((screen.getByLabelText("expects") as HTMLInputElement).value).toBe("4");
  });
});

describe("edge gestures", () => {
  beforeEach(() => mockRunsEndpoint(NO_RUNS));

  const yaml = () => document.querySelector<HTMLTextAreaElement>(".pane.source textarea")!.value;
  const edges = () => parseSpec(yaml()).edges.map((e) => `${e.from}->${e.to}:${e.carries.join(",")}`);
  const notice = () => document.querySelector(".canvas-notice")?.textContent ?? "";
  const gestures = () => {
    if (!canvasGestures.current) throw new Error("the canvas was given no gestures");
    return canvasGestures.current;
  };
  async function loadDiamond() {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    fireEvent.change(screen.getByDisplayValue("load an example…"), { target: { value: "diamond" } });
    await waitFor(() => expect(yaml()).toBe(FIXTURES.diamond));
  }

  it("draws an edge: the field is chosen, the target reads it, and one undo takes it all back", async () => {
    const user = userEvent.setup();
    await loadDiamond();
    const before = yaml();

    act(() => gestures().onConnect("worker_5", "merge"));
    const chooser = await screen.findByRole("dialog");
    expect(within(chooser).getByRole("button", { name: /claim/ })).toBeTruthy();
    await user.click(within(chooser).getByRole("button", { name: /source/ }));

    expect(edges()).toContain("worker_5->merge:source");
    expect(parseSpec(yaml()).nodes.find((n) => n.id === "merge")!.in.source).toBe("url");
    expect(notice()).toMatch(/wired worker_5 → merge, carrying source/);
    // The new edge is selected, and its panel says what it carries.
    expect(screen.getByRole("heading", { name: "edge worker_5 → merge" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "undo" }));
    expect(yaml()).toBe(before);
  });

  it("rewires the diamond's fan-in by dragging an edge's end, as one undoable edit", async () => {
    const user = userEvent.setup();
    await loadDiamond();
    const before = yaml();

    act(() => gestures().onRetarget({ from: "worker_5", to: "checker" }, "to", "merge"));
    expect(edges()).toContain("worker_5->merge:claim,source,date");
    expect(edges().filter((e) => e.includes("->checker:"))).toHaveLength(4);
    // The linter follows: the checker still expects five.
    expect(screen.getAllByText("SILENT_FAILURE").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "undo" }));
    expect(yaml()).toBe(before);
    await user.click(screen.getByRole("button", { name: "redo" }));
    expect(edges()).toContain("worker_5->merge:claim,source,date");
  });

  it("refuses a cycle with the reason and leaves the text alone", async () => {
    await loadDiamond();
    const before = yaml();
    act(() => gestures().onConnect("merge", "split"));
    expect(notice()).toMatch(/cycle: split → .* → merge → split/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(yaml()).toBe(before);
  });

  it("reaches an edge from the keyboard, deletes it with Delete, and Cmd+Z brings it back", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    const before = yaml();
    await user.selectOptions(screen.getByLabelText("inspect"), "review_b");

    await user.click(screen.getByRole("button", { name: "review_b → lint_docs" }));
    const heading = screen.getByRole("heading", { name: "edge review_b → lint_docs" });
    expect(document.activeElement).toBe(heading);
    // A fake edge says so, and says that deleting it is the repair.
    expect(screen.getByText("FAKE_EDGE", { selector: ".edge-fake .rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "delete this fake edge" })).toBeTruthy();

    await user.keyboard("{Delete}");
    expect(edges().some((e) => e.startsWith("review_b->lint_docs"))).toBe(false);
    expect(notice()).toMatch(/linter's repair, made by hand/);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(yaml()).toBe(before);
  });

  it("lets go of an edge that an undo took away", async () => {
    const user = userEvent.setup();
    await loadDiamond();
    act(() => gestures().onRetarget({ from: "worker_5", to: "checker" }, "to", "merge"));
    expect(screen.getByRole("heading", { name: "edge worker_5 → merge" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "undo" }));
    expect(screen.queryByRole("heading", { name: /^edge / })).toBeNull();
  });

  it("explains a dragged step once, and not again after it is dismissed", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    expect(screen.queryByRole("note")).toBeNull();

    act(() => gestures().onNodeDrag());
    const note = screen.getByRole("note", { name: "why the step went back" });
    expect(note.textContent).toMatch(/worked out from what it depends on/);
    await user.click(within(note).getByRole("button", { name: "understood" }));

    act(() => gestures().onNodeDrag());
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("gives the canvas no gestures in viewer mode", async () => {
    window.location.hash = "#view=1";
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    expect(canvasGestures.current).toBeUndefined();
    window.location.hash = "";
  });
});
