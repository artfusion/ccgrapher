// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

/**
 * The hopper inside the editor: the parse is shown before anything moves,
 * accepting writes one undoable edit, and a rejection keeps its reason.
 *
 * The server is a stubbed `fetch`. No model is called anywhere in this file:
 * drafting lives in `ccg serve`, and the canvas only ever posts to it.
 */

import { parseSpec } from "@ccgrapher/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftResponse } from "../lib/hopper";
import type { CCNode } from "../lib/view-model";

vi.mock("../app/canvas/canvas", () => ({
  Canvas: function CanvasMock({
    nodes,
    onSelect,
  }: {
    nodes: readonly CCNode[];
    onSelect?: (id: string | undefined) => void;
  }) {
    return (
      <div data-testid="canvas-mock" data-node-count={nodes.length}>
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            data-testid={`node-${n.id}`}
            data-ghost={n.data.ghost === true ? "true" : undefined}
            onClick={() => onSelect?.(n.id)}
          >
            {n.id}
          </button>
        ))}
      </div>
    );
  },
}));

const { Editor } = await import("../app/editor");

const SPEC = `version: 1
name: site
nodes:
  - { id: palette, label: Pick the palette, kind: worker, out: { palette: string } }
  - { id: stylesheet, label: Write the stylesheet, kind: worker, in: { palette: string }, out: { css: string }, writes: [site.css] }
  - { id: publish, label: Publish, kind: worker, in: { css: string, banner: string }, out: { url: string } }
edges:
  - { from: palette, to: stylesheet, carries: [palette] }
  - { from: stylesheet, to: publish, carries: [css] }
`;

const review = { agrees: true, note: "Honest as drafted.", changed: [] };

const PARSE: DraftResponse = {
  model: "claude-opus-5-5",
  candidates: [
    {
      id: "deeper_blue",
      label: "Make the homepage font a deeper blue",
      kind: "worker",
      tier: "cheap",
      in: { css: "string" },
      out: { css_tweak: "string" },
      writes: ["site.css"],
      rationale: "A small change to the stylesheet.",
      source: "make the homepage font a deeper blue",
      review: { agrees: false, note: "It never reads the palette itself.", changed: ["in"] },
      placement: { wave: 3, sentence: "Placed in wave 3, after “Write the stylesheet”, which it reads css from." },
      findings: [],
    },
    {
      id: "banner",
      label: "Draw the banner",
      kind: "worker",
      tier: "strong",
      in: {},
      out: { banner: "png" },
      writes: [],
      rationale: "Publish needs a banner.",
      source: "we still need the banner",
      review,
      findings: [],
      refusal: "it would hand “Publish” (banner) a new input, and that step has already started.",
    },
  ],
  duplicates: [{ text: "pick the palette", nodeId: "palette", reason: "That is an existing step." }],
  waitingOnYou: [{ text: "Should the footer say 2026?", kind: "question", recommendation: "Yes, from January." }],
  setAside: [{ text: "Honestly I am tired.", reason: "A feeling, not work." }],
};

/** `/runs` answers with nothing to watch; `/draft` with `draft`, or the given status. */
function stubServer(draft: { status: number; body: unknown }) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/draft")) return new Response(JSON.stringify(draft.body), { status: draft.status });
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const yaml = () => (document.querySelector(".pane.source textarea") as HTMLTextAreaElement).value;
const nodeCount = () => screen.getByTestId("canvas-mock").getAttribute("data-node-count");

async function openAndParse(user: ReturnType<typeof userEvent.setup>) {
  render(<Editor />);
  await screen.findByTestId("canvas-mock");
  fireEvent.change(document.querySelector(".pane.source textarea")!, { target: { value: SPEC } });
  await waitFor(() => expect(nodeCount()).toBe("3"));

  await user.click(screen.getByRole("button", { name: "drop in ideas" }));
  await user.type(
    screen.getByLabelText(/^Brain dump/),
    "make the homepage font a deeper blue, and the banner",
  );
  await user.click(screen.getByRole("button", { name: "parse" }));
  return screen.findByRole("heading", { name: "What it understood" });
}

describe("the hopper", () => {
  it("shows the parse, with reasons, before anything moves", async () => {
    const calls = stubServer({ status: 200, body: PARSE });
    const user = userEvent.setup();
    const heading = await openAndParse(user);

    // Focus goes to the parse, so the keyboard route lands on it.
    expect(document.activeElement).toBe(heading);

    // What was sent: the brain dump and the spec as written.
    const sent = calls.find((c) => c.url.endsWith("/draft"))!.body as Record<string, unknown>;
    expect(sent.brainDump).toBe("make the homepage font a deeper blue, and the banner");
    expect(sent.spec).toBe(SPEC);

    const cards = within(screen.getByRole("list", { name: "drafted steps" }));
    expect(cards.getByText("Make the homepage font a deeper blue")).toBeTruthy();
    expect(cards.getByText(/It never reads the palette itself/)).toBeTruthy();
    expect(cards.getByText(/Would be placed in wave 3, after “Write the stylesheet”/)).toBeTruthy();
    // The check refused the banner: it arrives rejected, with its reason.
    expect(cards.getByText(/Rejected: it would hand “Publish” \(banner\)/)).toBeTruthy();

    const merged = within(screen.getByRole("region", { name: "already in the plan" }));
    expect(merged.getByText("Pick the palette")).toBeTruthy();
    const waiting = within(screen.getByRole("region", { name: "waiting on you" }));
    expect(waiting.getByText(/Should the footer say 2026\?/)).toBeTruthy();
    expect(waiting.getByText(/Recommended: Yes, from January\./)).toBeTruthy();
    const aside = within(screen.getByRole("region", { name: "set aside" }));
    expect(aside.getByText(/A feeling, not work\./)).toBeTruthy();

    // Nothing has moved: the spec and the picture are as they were.
    expect(yaml()).toBe(SPEC);
    expect(nodeCount()).toBe("3");

    // Ghosts only when asked for, and drawn as ghosts.
    await user.click(screen.getByLabelText(/show the drafts on the canvas/));
    await waitFor(() => expect(nodeCount()).toBe("4"));
    expect(screen.getByTestId("node-deeper_blue").getAttribute("data-ghost")).toBe("true");
    expect(yaml()).toBe(SPEC);
  });

  it("accepts a draft as one undoable edit, and says where it went", async () => {
    stubServer({ status: 200, body: PARSE });
    const user = userEvent.setup();
    await openAndParse(user);

    await user.click(screen.getByRole("button", { name: "accept “Make the homepage font a deeper blue”" }));

    const spec = parseSpec(yaml());
    expect(spec.nodes.find((n) => n.id === "deeper_blue")).toMatchObject({ in: { css: "string" }, model: "cheap" });
    expect(spec.edges).toContainEqual({ from: "stylesheet", to: "deeper_blue", carries: ["css"] });
    await waitFor(() => expect(nodeCount()).toBe("4"));
    expect(screen.getByTestId("node-deeper_blue").getAttribute("data-ghost")).toBeNull();

    const sentence =
      "“Make the homepage font a deeper blue”: Placed in wave 3, after “Write the stylesheet”, which it reads css from.";
    const hopper = screen.getByRole("region", { name: "hopper" });
    expect(within(hopper).getByRole("status").textContent).toBe(sentence);
    // Focus lands on the card the button belonged to.
    expect(document.activeElement?.textContent).toMatch(/^Make the homepage font a deeper blue/);

    // One edit, so one undo takes it back exactly.
    await user.click(screen.getByRole("button", { name: "undo" }));
    expect(yaml()).toBe(SPEC);
    await waitFor(() => expect(nodeCount()).toBe("3"));
    expect(screen.getByText(/Taken back by an undo/)).toBeTruthy();
  });

  it("keeps a rejected draft, with its reason, until it is dismissed", async () => {
    stubServer({ status: 200, body: PARSE });
    const user = userEvent.setup();
    await openAndParse(user);

    await user.click(screen.getByRole("button", { name: "reject “Make the homepage font a deeper blue”" }));
    expect(screen.getByText("Rejected: rejected by you")).toBeTruthy();
    expect(yaml()).toBe(SPEC);

    await user.click(screen.getByRole("button", { name: "dismiss “Make the homepage font a deeper blue”" }));
    expect(screen.queryByText("Make the homepage font a deeper blue")).toBeNull();
    // The refused banner is still there with its reason; nothing was dismissed for it.
    expect(screen.getByText(/Rejected: it would hand/)).toBeTruthy();
  });

  it("opens a draft in the inspector, and an edit there changes the draft, not the spec", async () => {
    stubServer({ status: 200, body: PARSE });
    const user = userEvent.setup();
    await openAndParse(user);

    await user.click(screen.getByRole("button", { name: "edit “Make the homepage font a deeper blue” in the inspector" }));
    const panel = document.querySelector<HTMLElement>(".pane.inspector")!;
    expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe("Make the homepage font a deeper blue");

    await user.selectOptions(within(panel).getByLabelText("model"), "strong");
    expect(yaml()).toBe(SPEC);

    // Its edges come from its declarations: a gesture on one is refused, not written.
    await user.click(within(panel).getByRole("button", { name: /^delete edge stylesheet/ }));
    expect(yaml()).toBe(SPEC);
    expect(screen.getByText(/A drafted step's edges follow from its in and out/)).toBeTruthy();
    const cards = within(screen.getByRole("list", { name: "drafted steps" }));
    const card = cards.getByRole("heading", { name: /^Make the homepage font a deeper blue/ }).closest("li")!;
    expect(within(card).getByText(/^worker, strong/)).toBeTruthy();
  });

  it("says how to turn drafting on when the server is not drafting", async () => {
    stubServer({ status: 404, body: { error: "drafting is off" } });
    const user = userEvent.setup();
    render(<Editor />);
    await screen.findByTestId("canvas-mock");
    await user.click(screen.getByRole("button", { name: "drop in ideas" }));
    await user.type(screen.getByLabelText(/^Brain dump/), "an idea");
    // The keyboard route: Ctrl+Enter sends from the text area.
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Drafting is not turned on .* ccg serve <dir> --drafting and ANTHROPIC_API_KEY/,
    );
  });
});
