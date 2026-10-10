// SPDX-License-Identifier: Apache-2.0
import { parseSpec } from "@ccgrapher/core";
import type { RunState } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { buildModel } from "../lib/graph-model";
import {
  itemsFrom,
  markGhosts,
  postDraft,
  startedSteps,
  statusOf,
  withGhosts,
  type DraftCandidate,
  type DraftResponse,
} from "../lib/hopper";

const SPEC = parseSpec(`
version: 1
name: site
nodes:
  - { id: stylesheet, label: Write the stylesheet, kind: worker, out: { css: string } }
  - { id: publish, label: Publish, kind: worker, in: { css: string, banner: string }, out: { url: string } }
edges:
  - { from: stylesheet, to: publish, carries: [css] }
`);

const candidate = (over: Partial<DraftCandidate>): DraftCandidate => ({
  id: "x",
  label: "X",
  kind: "worker",
  tier: "cheap",
  in: {},
  out: {},
  writes: [],
  rationale: "",
  source: "",
  review: { agrees: true, note: "", changed: [] },
  findings: [],
  ...over,
});

const response = (candidates: DraftCandidate[]): DraftResponse => ({
  model: "m",
  candidates,
  duplicates: [],
  waitingOnYou: [],
  setAside: [],
});

describe("postDraft", () => {
  const answer = (status: number, body: unknown): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status });

  it("tells a server that is not drafting from one that is not there", async () => {
    expect(await postDraft("http://s", { brainDump: "a", spec: "b" }, answer(404, {}))).toEqual({ kind: "off" });
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await postDraft("http://s", { brainDump: "a", spec: "b" }, down)).toEqual({ kind: "unreachable" });
  });

  it("passes the server's own reason through", async () => {
    expect(await postDraft("http://s", { brainDump: "a", spec: "b" }, answer(413, { error: "too long" }))).toEqual({
      kind: "error",
      message: "too long",
    });
  });
});

describe("startedSteps", () => {
  it("counts anything the run has moved past pending", () => {
    const run = {
      nodes: new Map([
        ["stylesheet", { status: "done", tail: [] }],
        ["publish", { status: "pending", tail: [] }],
      ]),
    } as unknown as RunState;
    expect([...startedSteps(run)]).toEqual(["stylesheet"]);
    expect(startedSteps(undefined).size).toBe(0);
  });
});

describe("ghosts", () => {
  const items = itemsFrom(
    response([
      candidate({ id: "tweak", label: "Tweak", in: { css: "string" }, out: { tweak: "string" } }),
      candidate({ id: "banner", label: "Banner", out: { banner: "png" } }),
      candidate({ id: "refused", label: "Refused", refusal: "no" }),
    ]),
  );

  it("places pending drafts and leaves out those that cannot be placed", () => {
    expect(items.map((i) => i.status)).toEqual(["pending", "pending", "rejected"]);
    // Publish has started, so the banner may not become its input.
    const { spec, ghosts } = withGhosts(SPEC, items, new Set(["stylesheet", "publish"]));
    expect([...ghosts]).toEqual(["tweak"]);
    expect(spec.nodes.map((n) => n.id)).toEqual(["stylesheet", "publish", "tweak"]);
  });

  it("draws them as ghosts and moves nothing that layout placed", () => {
    const { spec, ghosts } = withGhosts(SPEC, items, new Set());
    const model = buildModel(JSON.stringify(spec), false);
    if (!model.ok) throw new Error(model.error);
    const marked = markGhosts(model, ghosts);
    expect(marked.nodes.map((n) => n.position)).toEqual(model.nodes.map((n) => n.position));
    expect(marked.nodes.filter((n) => n.data.ghost).map((n) => n.id)).toEqual(["tweak", "banner"]);
    expect(marked.edges.filter((e) => e.data?.ghost).map((e) => `${e.source}->${e.target}`)).toEqual([
      "stylesheet->tweak",
      "banner->publish",
    ]);
  });

  it("reads an accepted draft that an undo took back as pending again", () => {
    const accepted = { ...items[0]!, status: "accepted" as const };
    expect(statusOf(accepted, SPEC)).toBe("pending");
    const placed = { ...SPEC, nodes: [...SPEC.nodes, accepted.node] };
    expect(statusOf(accepted, placed)).toBe("accepted");
  });
});
