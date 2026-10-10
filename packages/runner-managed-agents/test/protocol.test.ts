// SPDX-License-Identifier: Apache-2.0
import { buildGraph, parseSpec, WorkflowSpec } from "@ccgrapher/core";
import { codegenFiles } from "@ccgrapher/codegen";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clientFromEnvironment,
  inputMessage,
  LockError,
  parseLock,
  PROTOCOL,
  readOutput,
  resolveIds,
} from "../src/index.js";

const example = fileURLToPath(new URL("../../../examples/research-desk.yaml", import.meta.url));
const desk = () => buildGraph(parseSpec(readFileSync(example, "utf8"), example));

const node = (out: Record<string, string>) =>
  WorkflowSpec.parse({ version: 1, name: "x", nodes: [{ id: "n", label: "n", kind: "worker", out }], edges: [] })
    .nodes[0]!;

describe("reading the output", () => {
  it("takes a reply that is one JSON object", () => {
    expect(readOutput(node({ a: "string" }), ' {"a": 1, "extra": true} ')).toEqual({ a: 1, extra: true });
  });

  it("takes the last json block when the reply has prose around it", () => {
    const reply = 'First try:\n```json\n{"a": 0}\n```\nCorrected:\n```json\n{"a": 2}\n```\nDone.';
    expect(readOutput(node({ a: "string" }), reply)).toEqual({ a: 2 });
  });

  it("refuses an array, and says what the reply began with", () => {
    expect(() => readOutput(node({ a: "string" }), "[1, 2]")).toThrow(/n: the reply is not a JSON object.*began: "\[1, 2\]"/);
  });

  it("needs nothing from a node that declares no output", () => {
    expect(readOutput(node({}), "I tidied up.")).toBeUndefined();
    expect(readOutput(node({}), undefined)).toBeUndefined();
  });
});

describe("the input message", () => {
  it("is a sentence, then the envelope in a json block", () => {
    const text = inputMessage({
      protocol: PROTOCOL,
      run: "r",
      spec: "s",
      node: "research",
      instance: 1,
      of: 5,
      args: {},
      inputs: [{ from: "plan", fields: ["angle"], output: { angle: "x" } }],
    });
    expect(text.split("\n")[0]).toBe(
      "Input for the `research` step, copy 1 of 5 (counting from 0), as ccg-node-input/1. Reply as your instructions say: one JSON object with your output fields.",
    );
    const json = /```json\n([\s\S]*)\n```$/.exec(text)?.[1];
    expect(JSON.parse(json!)).toMatchObject({ protocol: "ccg-node-input/1", node: "research", instance: 1 });
  });

  it("is the envelope the generated system prompt describes", () => {
    const files = codegenFiles(desk(), "managed-agents");
    const prompt = files["agents/research/agent.md"]!;
    for (const field of ["`node`", "`instance`", "`of`", "`args`", "`inputs`", "`from`", "`fields`", "`output`", "```json"]) {
      expect(prompt).toContain(field);
    }
  });
});

describe("the lock file", () => {
  it("finds each agent by the path the codegen target wrote it to", () => {
    const ids = resolveIds(desk(), {
      resources: {
        "./agents/plan/agent.md": { id: "a1" },
        "agents/research/agent.md": { id: "a2" },
        "./agents/skeptic-correct/agent.md": { id: "a3" },
        "./agents/skeptic-current/agent.md": { id: "a4" },
        "./agents/skeptic-source/agent.md": { id: "a5" },
        "./agents/report/agent.md": { id: "a6" },
        "./agents/research-desk/environment.yaml": { id: "e1" },
        "./skills/unrelated/SKILL.md": { id: "s1" },
      },
    });
    expect(Object.fromEntries(ids.agents)).toEqual({
      plan: "a1",
      research: "a2",
      skeptic_correct: "a3",
      skeptic_current: "a4",
      skeptic_source: "a5",
      report: "a6",
    });
    expect(ids.environment).toBe("e1");
  });

  it("names every file it has no id for, at once", () => {
    expect(() => resolveIds(desk(), { resources: { "./agents/plan/agent.md": { id: "a1" } } })).toThrow(
      /no id for 6 file\(s\): research \(agents\/research\/agent\.md\), .*report \(agents\/report\/agent\.md\), the environment \(agents\/research-desk\/environment\.yaml\)/,
    );
  });

  it("refuses JSON that is not a lock file", () => {
    expect(() => parseLock({ agents: [] })).toThrow(LockError);
    expect(() => parseLock({ resources: { "./a.md": { name: "x" } } })).toThrow("./a.md has no string 'id'");
  });
});

describe("credentials", () => {
  it("builds no client, and loads no SDK, when the environment names no key", async () => {
    await expect(clientFromEnvironment({})).resolves.toBeUndefined();
    await expect(clientFromEnvironment({ ANTHROPIC_API_KEY: "" })).resolves.toBeUndefined();
  });

  it("would load the SDK with a key, which the test setup refuses", async () => {
    await expect(clientFromEnvironment({ ANTHROPIC_API_KEY: "sk-test" })).rejects.toThrow(
      "the Anthropic SDK is disabled in tests",
    );
  });
});
