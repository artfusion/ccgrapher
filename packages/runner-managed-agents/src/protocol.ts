// SPDX-License-Identifier: Apache-2.0
import type { NodeSpec } from "@ccgrapher/core";
import type { NodeContext } from "@ccgrapher/runner";

/**
 * The message protocol between the runner and one node's session.
 *
 * In: the session's first and only `user.message` is one line of plain text and
 * then a fenced ```json block holding `NodeInput`. The system prompt the
 * managed-agents codegen target writes describes the same envelope, so the two
 * change together.
 *
 * Out: the text of the last `agent.message` before the session goes idle with
 * `end_turn`, read as one JSON object. Either the whole reply is the object, or
 * the last ```json block in it is. A reply with no object, or an object missing
 * a declared output field, fails the node with a message saying which.
 */
export const PROTOCOL = "ccg-node-input/1";

export interface NodeInput {
  readonly protocol: typeof PROTOCOL;
  readonly run: string;
  readonly spec: string;
  readonly node: string;
  /** Present only for a fanned node: which copy this is, from 0, and how many there are. */
  readonly instance?: number;
  readonly of?: number;
  readonly args: Readonly<Record<string, unknown>>;
  readonly inputs: ReadonlyArray<{
    readonly from: string;
    readonly instance?: number;
    readonly fields: readonly string[];
    readonly output: unknown;
  }>;
}

export function nodeInput(context: NodeContext, spec: string): NodeInput {
  return {
    protocol: PROTOCOL,
    run: context.runId,
    spec,
    node: context.node.id,
    ...(context.instance === undefined ? {} : { instance: context.instance, of: context.of }),
    args: context.args,
    inputs: context.inputs.map((arrival) => ({
      from: arrival.from,
      ...(arrival.instance === undefined ? {} : { instance: arrival.instance }),
      fields: arrival.fields,
      output: arrival.output,
    })),
  };
}

/** The text of the first message, envelope included. */
export function inputMessage(input: NodeInput): string {
  const which =
    input.instance === undefined ? "" : `, copy ${input.instance} of ${input.of ?? "?"} (counting from 0)`;
  return [
    `Input for the \`${input.node}\` step${which}, as ${PROTOCOL}. Reply as your instructions say: one JSON object with your output fields.`,
    "",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
  ].join("\n");
}

/** A node's output could not be read from the session's reply. Always a node failure. */
export class OutputError extends Error {
  override readonly name = "OutputError";
}

/**
 * Reads the declared output out of the final reply.
 *
 * A node that declares no output fields has nothing to read, so any reply, or
 * none, is accepted and nothing goes downstream. Otherwise the reply must hold
 * a JSON object with every declared field. Extra fields are kept: `carries` is
 * a declaration the linter checks, and dropping data here would be the runner
 * editing the run.
 */
export function readOutput(node: NodeSpec, reply: string | undefined): Record<string, unknown> | undefined {
  const declared = Object.keys(node.out);
  if (declared.length === 0) return undefined;
  if (reply === undefined || reply.trim() === "") {
    throw new OutputError(
      `${node.id}: the session finished its turn without a reply, so there is no output to read (expected a JSON object with ${list(declared)})`,
    );
  }

  const value = parseObject(reply);
  if (value === undefined) {
    throw new OutputError(
      `${node.id}: the reply is not a JSON object, either whole or in a \`\`\`json block (expected ${list(declared)}); it began: ${JSON.stringify(reply.trim().slice(0, 80))}`,
    );
  }
  const missing = declared.filter((field) => !(field in value));
  if (missing.length > 0) {
    throw new OutputError(`${node.id}: the reply's JSON object is missing the declared output field(s) ${list(missing)}`);
  }
  return value;
}

function parseObject(reply: string): Record<string, unknown> | undefined {
  const whole = tryObject(reply.trim());
  if (whole) return whole;
  const blocks = [...reply.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  return last === undefined ? undefined : tryObject(last.trim());
}

function tryObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const list = (fields: readonly string[]) => fields.map((field) => `'${field}'`).join(", ");
