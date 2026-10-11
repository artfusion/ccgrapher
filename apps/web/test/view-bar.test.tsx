// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

/**
 * Layers, theme and density in the editor: they change what is drawn and how the
 * page looks, never the spec, the layout or the lint result, and the choice is
 * remembered in this browser alone.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY, parsePreferences, DEFAULT_PREFERENCES } from "../lib/preferences";
import { DEFAULT_FIXTURE, FIXTURES } from "../lib/fixtures";
import type { CCEdge, CCNode } from "../lib/view-model";

vi.mock("../app/canvas/canvas", () => ({
  Canvas: ({ nodes, edges }: { nodes: readonly CCNode[]; edges: readonly CCEdge[] }) => (
    <div
      data-testid="canvas-mock"
      data-positions={JSON.stringify(nodes.map((n) => [n.id, n.position]))}
      data-problems={nodes.reduce((n, x) => n + (x.data.problems as string[]).length, 0)}
      data-labels={JSON.stringify(edges.map((e) => e.label ?? null))}
    />
  ),
}));

const { Editor } = await import("../app/editor");

// The test runtime's own localStorage is not reliably there, so the page gets a
// plain in-memory one, which is also what lets a test make it throw.
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}
let store = memoryStorage();

beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })),
  );
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const canvas = () => screen.getByTestId("canvas-mock");
const spec = () => document.querySelector<HTMLTextAreaElement>("textarea")!.value;
const footer = () => document.querySelector("footer")!.textContent;

describe("layers", () => {
  it("leave the spec text, the positions and the lint report alone", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    const yaml = spec();
    const positions = canvas().getAttribute("data-positions");
    const report = footer();
    expect(Number(canvas().getAttribute("data-problems"))).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText("lint findings"));

    await waitFor(() => expect(canvas().getAttribute("data-problems")).toBe("0"));
    expect(spec()).toBe(yaml);
    expect(canvas().getAttribute("data-positions")).toBe(positions);
    expect(footer()).toBe(report);
  });

  it("can hide the field names on edges", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    fireEvent.click(screen.getByLabelText("fields on edges"));
    await waitFor(() => {
      const labels = JSON.parse(canvas().getAttribute("data-labels")!) as (string | null)[];
      expect(labels.every((l) => l === null || l === "carries no data")).toBe(true);
    });
  });

  it("are remembered across a remount, and only in storage", async () => {
    const first = render(<Editor />);
    await screen.findByTestId("canvas-mock");
    fireEvent.click(screen.getByLabelText("lint findings"));
    expect(JSON.parse(store.getItem(STORAGE_KEY)!).layers.findings).toBe(false);
    first.unmount();

    render(<Editor />);
    await waitFor(() =>
      expect((screen.getByLabelText("lint findings") as HTMLInputElement).checked).toBe(false),
    );
    expect(canvas().getAttribute("data-problems")).toBe("0");
    // The spec text carries none of it.
    expect(spec()).toBe(FIXTURES[DEFAULT_FIXTURE]);
  });

  it("work without storage", async () => {
    vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    fireEvent.click(screen.getByLabelText("lint findings"));
    await waitFor(() => expect(canvas().getAttribute("data-problems")).toBe("0"));
  });
});

describe("theme and density", () => {
  it("a manual theme overrides the system and is kept", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    fireEvent.change(screen.getByLabelText("theme"), { target: { value: "dark" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(JSON.parse(store.getItem(STORAGE_KEY)!).theme).toBe("dark");

    fireEvent.change(screen.getByLabelText("theme"), { target: { value: "system" } });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("density is an attribute on the page", async () => {
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    fireEvent.change(screen.getByLabelText("density"), { target: { value: "compact" } });
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  });

  it("a stored theme is applied on load", async () => {
    store.setItem(STORAGE_KEY, JSON.stringify({ theme: "light", density: "compact" }));
    render(<Editor />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  });
});

describe("parsePreferences", () => {
  it("falls back to the defaults on anything it does not recognise", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("not json")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('{"theme":"neon","density":3,"layers":{"findings":"no"}}')).toEqual(
      DEFAULT_PREFERENCES,
    );
  });
});
