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

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CCEdge, CCNode } from "../lib/view-model";

vi.mock("../app/canvas/canvas", () => ({
  Canvas: ({ nodes }: { nodes: readonly CCNode[]; edges: readonly CCEdge[] }) => (
    <div data-testid="canvas-mock" data-node-count={nodes.length} />
  ),
}));

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

  it("shows the parse error instead of mounting the canvas", async () => {
    render(<Editor />);
    // Let the first (valid) render settle before breaking it, so the
    // assertion below is about the transition, not a race with mount.
    await screen.findByTestId("canvas-mock");

    // fireEvent.change rather than user-event: the spec deliberately contains
    // `[`, which user-event's keystroke DSL reads as a key-name delimiter.
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: BROKEN_SPEC } });

    expect(await screen.findByText("spec error")).toBeTruthy();
    expect(screen.queryByTestId("canvas-mock")).toBeNull();
    expect(document.querySelector("pre.error")?.textContent).toMatch(/not valid YAML/);
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
