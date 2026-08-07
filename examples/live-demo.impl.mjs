// SPDX-License-Identifier: Apache-2.0

/**
 * The implementation half of examples/live-demo.yaml.
 *
 * `ccg run` imports this module and pairs every node id in the spec with the
 * export of the same name. There is no `review` export because `review` is a
 * gate: a gate is answered by a human, never executed, and an implementation
 * for one could only ever be dead code.
 *
 * Every node sleeps for a few milliseconds instead of calling a model, so the
 * demo runs anywhere — no API key, no network, no clock worth waiting on.
 * `fetch_code` fails on purpose. That is the point of the fixture: the run has
 * to keep going down the branch that still works, skip the branch that cannot,
 * and end up saying so.
 *
 * A node is handed a `NodeContext` and returns `{ output?, usage? }`, or
 * nothing. `context.inputs` holds only the results that genuinely arrived —
 * never padded, never holed — so reading them is how a node sees its upstream.
 */

/**
 * What this module verified was reachable before the run, one
 * `capability_available` each. Exporting it is optional: a module that says
 * nothing is a module where nobody looked, which is not the same as a module
 * reporting that nothing was there.
 */
export const capabilities = ["mcp:docs/fetch"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whatever the named upstream delivered, or undefined if it delivered nothing. */
function from(context, id) {
  return context.inputs.find((input) => input.from === id)?.output;
}

export async function plan(context) {
  context.log("splitting the job into docs and code");
  await sleep(20);
  return {
    output: { docs_url: "https://example.invalid/docs/live-demo", code_path: "src/live-demo" },
    usage: { model: "demo-cheap", inputTokens: 90, outputTokens: 30, costUsd: 0.0004 },
  };
}

export async function fetch_docs(context) {
  const { docs_url: url } = from(context, "plan") ?? {};
  context.log(`reading ${url}`);
  // The other half of `uses: ["mcp:docs/fetch"]` in the spec. The declaration is
  // a claim; this is the node saying it actually reached for the thing.
  context.capability("mcp:docs/fetch");
  await sleep(40);
  return {
    output: { notes: "- the runner walks ranks\n- the trace is the record\n" },
    usage: { model: "demo-cheap", inputTokens: 400, outputTokens: 120, costUsd: 0.0018 },
  };
}

export async function fetch_code(context) {
  const { code_path: path } = from(context, "plan") ?? {};
  context.log(`opening ${path}`);
  await sleep(15);
  // On purpose, every time. A demo where nothing ever fails teaches nobody what
  // a failure looks like.
  throw new Error(`${path} is not checked out — this node fails by design`);
}

export async function count_lines(context) {
  // Never reached: `fetch_code` delivered nothing, so the engine skips this
  // rather than running it on a hole where its input should be.
  await sleep(5);
  return { output: { total: (from(context, "fetch_code")?.symbols ?? []).length } };
}

export async function summarise(context) {
  const { notes } = from(context, "fetch_docs") ?? {};
  context.log("drafting the summary from the notes that arrived");
  await sleep(35);
  return {
    output: { summary: `# live-demo\n\n${notes ?? "(no notes)"}` },
    usage: { model: "demo-strong", inputTokens: 620, outputTokens: 210, costUsd: 0.0091 },
  };
}

export async function publish(context) {
  // The gate hands its payload through unchanged, so what arrives here is what
  // the human actually looked at.
  await sleep(10);
  context.log("would write out/live-demo.md");
  return { output: { path: "out/live-demo.md" } };
}
