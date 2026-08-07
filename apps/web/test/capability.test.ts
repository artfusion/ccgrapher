// SPDX-License-Identifier: Apache-2.0
import { emptyRunState, reduceRun, type RunState, type TraceEvent } from "@ccgrapher/trace";
import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { applyCapabilityState, declaredRows, invokedRows } from "../lib/capability";
import { buildModel } from "../lib/graph-model";
import { NOT_RECORDED } from "../lib/run-detail";

const SPEC = `version: 1
name: caps
nodes:
  - id: a
    label: a
    kind: worker
    in: { t: string }
    out: { x: string }
    uses: ["mcp:github/pr", "skill:rebase"]
  - id: b
    label: b
    kind: worker
    in: { x: string }
    out: { y: string }
edges:
  - { from: a, to: b, carries: [x] }
`;

function positioned(): Node[] {
  const model = buildModel(SPEC, false);
  if (!model.ok) throw new Error(model.error);
  return model.nodes;
}

const ts = "2026-08-01T00:00:00.000Z";
const envelope = { v: 1, runId: "r", ts } as const;

const start = (node: string, seq: number): TraceEvent => ({
  ...envelope,
  seq,
  type: "node_started",
  node,
});
const finish = (node: string, seq: number): TraceEvent => ({
  ...envelope,
  seq,
  type: "node_finished",
  node,
  durationMs: 4,
});
const available = (capability: string, seq: number): TraceEvent => ({
  ...envelope,
  seq,
  type: "capability_available",
  capability,
});
const lost = (capability: string, seq: number): TraceEvent => ({
  ...envelope,
  seq,
  type: "capability_lost",
  capability,
  reason: "the server stopped answering",
});
const invoked = (capability: string, seq: number, node?: string): TraceEvent => ({
  ...envelope,
  seq,
  type: "capability_invoked",
  capability,
  ...(node === undefined ? {} : { node }),
});

function fold(...events: TraceEvent[]): RunState {
  return events.reduce(reduceRun, emptyRunState("r"));
}

interface Capability {
  declared: readonly string[];
  invoked: readonly string[];
  alert?: "gap" | "undeclared";
}

function capabilityOf(nodes: Node[], id: string): Capability {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  const state = (node.data as { capability?: Capability }).capability;
  if (!state) throw new Error(`no capability state on ${id}`);
  return state;
}

describe("the capability overlay", () => {
  it("says nothing when the spec and the run agree", () => {
    const run = fold(
      start("a", 0),
      available("mcp:github/pr", 1),
      invoked("mcp:github/pr", 2, "a"),
      invoked("skill:rebase", 3, "a"),
    );
    const after = applyCapabilityState(positioned(), run);
    const caps = capabilityOf(after, "a");

    expect(caps.declared).toEqual(["mcp:github/pr", "skill:rebase"]);
    expect(caps.invoked).toEqual(["mcp:github/pr", "skill:rebase"]);
    expect(caps.alert).toBeUndefined();
    expect(after.find((n) => n.id === "a")!.className ?? "").not.toContain("capability");
  });

  it("flags a node that used something it never declared", () => {
    const run = fold(start("a", 0), invoked("mcp:jira/issue", 1, "a"));
    const after = applyCapabilityState(positioned(), run);

    expect(capabilityOf(after, "a").alert).toBe("undeclared");
    expect(after.find((n) => n.id === "a")!.className).toContain("capability-undeclared");
  });

  it("flags a running node whose declared capability is gone right now", () => {
    const run = fold(start("a", 0), available("mcp:github/pr", 1), lost("mcp:github/pr", 2));
    const after = applyCapabilityState(positioned(), run);

    expect(capabilityOf(after, "a").alert).toBe("gap");
    expect(after.find((n) => n.id === "a")!.className).toContain("capability-gap");
  });

  it("stops flagging a gap once the capability comes back", () => {
    const run = fold(
      start("a", 0),
      available("mcp:github/pr", 1),
      lost("mcp:github/pr", 2),
      available("mcp:github/pr", 3),
    );
    expect(capabilityOf(applyCapabilityState(positioned(), run), "a").alert).toBeUndefined();
  });

  it("never raises a gap from silence — absent is not zero", () => {
    // The whole rule, in one case. `a` is running and declares two capabilities;
    // the run has reported availability for neither, because most runtimes
    // report none. Unknown is not missing, and a node tinted here would be a
    // false alarm manufactured out of a runtime that simply does not say.
    const run = fold(start("a", 0));
    const after = applyCapabilityState(positioned(), run);
    const caps = capabilityOf(after, "a");

    expect(run.capabilities.size).toBe(0);
    expect(caps.alert).toBeUndefined();
    expect(after.find((n) => n.id === "a")!.className ?? "").not.toContain("capability");
  });

  it("does not raise a gap from an invocation alone", () => {
    // An invocation says something used it, not that anything checked whether
    // it was there: `available` is still absent afterwards, and absent is quiet.
    const run = fold(start("a", 0), invoked("mcp:github/pr", 1, "a"));
    expect(run.capabilities.get("mcp:github/pr")?.available).toBeUndefined();
    expect(capabilityOf(applyCapabilityState(positioned(), run), "a").alert).toBeUndefined();
  });

  it("keeps the gap to the present tense", () => {
    // `a` finished before the capability went away. Reading a whole run back and
    // pairing each node with the availability at its own moment is a different
    // tool's job; this overlay only ever says what is true now.
    const run = fold(
      start("a", 0),
      available("mcp:github/pr", 1),
      finish("a", 2),
      lost("mcp:github/pr", 3),
    );
    const caps = capabilityOf(applyCapabilityState(positioned(), run), "a");
    expect(caps.alert).toBeUndefined();
  });

  it("raises a gap on a partially settled fanned node too", () => {
    const fanned: TraceEvent = {
      ...envelope,
      seq: 0,
      type: "node_started",
      node: "a",
      instance: 0,
      of: 2,
    };
    const oneLanded: TraceEvent = {
      ...envelope,
      seq: 1,
      type: "node_finished",
      node: "a",
      instance: 0,
      durationMs: 4,
    };
    const run = fold(fanned, oneLanded, lost("skill:rebase", 2));
    expect(run.nodes.get("a")?.status).toBe("partial");
    expect(capabilityOf(applyCapabilityState(positioned(), run), "a").alert).toBe("gap");
  });

  it("prefers the gap when a node is in both kinds of trouble", () => {
    const run = fold(start("a", 0), lost("mcp:github/pr", 1), invoked("plugin:notes", 2, "a"));
    // One is a step reaching now for something that is not there; the other is a
    // spec that has drifted. Only the first is happening.
    expect(capabilityOf(applyCapabilityState(positioned(), run), "a").alert).toBe("gap");
  });

  it("leaves a node the run has not mentioned with its declarations intact", () => {
    const run = fold(start("a", 0), invoked("mcp:jira/issue", 1, "a"));
    const after = applyCapabilityState(positioned(), run);
    const b = capabilityOf(after, "b");

    expect(b.invoked).toEqual([]);
    expect(b.declared).toEqual([]);
    expect(b.alert).toBeUndefined();

    const a = capabilityOf(after, "a");
    expect(a.declared).toEqual(["mcp:github/pr", "skill:rebase"]);
  });

  it("attributes an invocation to nobody when the event named no node", () => {
    // An adapter watching a live agent session knows a tool was used and has no
    // node to pin it to. Guessing one would be this overlay inventing an
    // attribution nobody made.
    const run = fold(start("a", 0), invoked("mcp:jira/issue", 1));
    const after = applyCapabilityState(positioned(), run);
    expect(capabilityOf(after, "a").invoked).toEqual([]);
    expect(capabilityOf(after, "a").alert).toBeUndefined();
  });

  it("returns the same array when there is no run", () => {
    const before = positioned();
    expect(applyCapabilityState(before, undefined)).toBe(before);
  });
});

describe("capability rows", () => {
  it("prints a declared capability nobody reported using as not recorded", () => {
    const rows = declaredRows(["mcp:github/pr", "skill:rebase"], ["skill:rebase"]);
    expect(rows).toEqual([
      { label: "mcp:github/pr", value: NOT_RECORDED, recorded: false },
      { label: "skill:rebase", value: "used", recorded: true },
    ]);
  });

  it("says which used capabilities the spec never mentioned", () => {
    const rows = invokedRows(["skill:rebase"], ["skill:rebase", "mcp:jira/issue"]);
    expect(rows.map((row) => row.value)).toEqual(["declared", "never declared"]);
    // Both are things the run genuinely reported, so neither is an absence.
    expect(rows.every((row) => row.recorded)).toBe(true);
  });

  it("prints what the spec declared and nothing the run added on its own", () => {
    // The undeclared side is `invokedRows`' job. A capability the run reached
    // for that the spec never mentioned gets no row here, however loudly it was
    // used — this list is the spec's, read against the run.
    const rows = declaredRows(["skill:rebase"], ["skill:rebase", "mcp:jira/issue"]);
    expect(rows).toEqual([{ label: "skill:rebase", value: "used", recorded: true }]);

    // So a spec that declares nothing has no rows at all, whatever the run did.
    expect(declaredRows([], ["mcp:jira/issue"])).toEqual([]);
  });
});
