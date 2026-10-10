// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serveCommand } from "../src/commands/serve.js";
import {
  CHECK_SYSTEM,
  createDrafter,
  DEFAULT_DRAFT_MODEL,
  MAX_BRAIN_DUMP_CHARS,
  PARSE_SYSTEM,
  type DraftCallParams,
  type DraftingClient,
  type DraftMessage,
} from "../src/drafting.js";
import { DRAFTING_OFF, startTraceServer, type TraceServer } from "../src/serve.js";

/**
 * Every client here is a fake. vitest aliases the SDK to a module that throws
 * on import, so nothing in this file can reach a real account even by mistake.
 */

const SPEC = `version: 1
name: site
# the homepage build
nodes:
  - { id: palette, label: Pick the palette, kind: worker, out: { palette: string } }
  - { id: stylesheet, label: Write the stylesheet, kind: worker, in: { palette: string }, out: { css: string }, writes: [site.css] }
  - { id: publish, label: Publish, kind: worker, in: { css: string, banner: string }, out: { url: string } }
edges:
  - { from: palette, to: stylesheet, carries: [palette] }
  - { from: stylesheet, to: publish, carries: [css] }
`;

const BRAIN_DUMP =
  "Make the homepage font a deeper blue. Also we still need the banner for publish. " +
  "Should the footer say 2026? And the palette step, someone has to pick it. Honestly I am tired.";

const KEY = "sk-ant-test-0123456789-not-a-real-key";

const field = (name: string, type = "string") => ({ name, type });

const PARSE = {
  candidates: [
    {
      label: "Make the homepage font a deeper blue",
      kind: "worker",
      tier: "cheap",
      in: [field("css"), field("palette")],
      out: [field("css_tweak")],
      writes: ["site.css"],
      rationale: "A small change to the stylesheet.",
      source: "Make the homepage font a deeper blue.",
    },
    {
      label: "Draw the banner",
      kind: "worker",
      tier: "strong",
      in: [],
      out: [field("banner", "png")],
      writes: [],
      rationale: "Publish needs a banner and nothing makes one.",
      source: "we still need the banner for publish",
    },
    {
      label: "Summon a wizard",
      kind: "wizard",
      tier: "cheap",
      in: [],
      out: [field("magic")],
      writes: [],
      rationale: "A kind the schema does not have.",
      source: "a line the model misread",
    },
  ],
  duplicates: [
    { text: "the palette step, someone has to pick it", nodeId: "palette", reason: "That is Pick the palette." },
    { text: "a ghost", nodeId: "no_such_step", reason: "A step the model imagined." },
  ],
  waitingOnYou: [
    { text: "Should the footer say 2026?", kind: "question", recommendation: "Yes, from January." },
  ],
  setAside: [{ text: "Honestly I am tired.", reason: "A feeling, not work." }],
};

const CHECK = {
  reviews: [
    {
      id: "make_the_homepage_font_a_deeper_blue",
      agrees: false,
      in: [field("css")],
      out: [field("css_tweak")],
      writes: ["site.css"],
      note: "It edits the stylesheet; it never reads the palette itself.",
    },
    {
      id: "draw_the_banner",
      agrees: true,
      in: [],
      out: [field("banner", "png")],
      writes: [],
      note: "Honest as drafted.",
    },
  ],
};

function message(value: unknown, stop_reason = "end_turn"): DraftMessage {
  return { content: [{ type: "thinking" }, { type: "text", text: JSON.stringify(value) }], stop_reason };
}

/** A fake that answers each call in turn and keeps what it was asked. */
function fakeClient(...replies: Array<DraftMessage | Error>) {
  const calls: DraftCallParams[] = [];
  const client: DraftingClient = {
    messages: {
      create: async (params) => {
        calls.push(params);
        const reply = replies.shift();
        if (!reply) throw new Error("the fake has no more replies");
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  return { client, calls };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ccg-draft-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: TraceServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  vi.restoreAllMocks();
});

async function serveWith(client: DraftingClient | undefined, log: string[] = []) {
  const draft = client
    ? createDrafter({ client, secrets: [KEY], log: (line) => log.push(line) })
    : undefined;
  const server = await startTraceServer({ dir, port: 0, draft });
  servers.push(server);
  return server;
}

async function post(server: TraceServer, body: unknown) {
  const res = await fetch(`${server.url}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

describe("POST /draft", () => {
  it("parses, checks in a fresh context, lints, and places each candidate", async () => {
    const { client, calls } = fakeClient(message(PARSE), message(CHECK));
    const server = await serveWith(client);
    const { status, json } = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(status).toBe(200);

    // Two calls: the parse, then the check.
    expect(calls).toHaveLength(2);
    const [parse, check] = calls as [DraftCallParams, DraftCallParams];
    expect(parse.model).toBe(DEFAULT_DRAFT_MODEL);
    expect(parse.thinking).toEqual({ type: "adaptive" });
    expect(parse.output_config.format.type).toBe("json_schema");
    expect(parse.system).toBe(PARSE_SYSTEM);
    // What is sent: the spec as written and the brain dump, nothing else.
    expect(parse.messages).toEqual([
      { role: "user", content: `<spec>\n${SPEC}</spec>\n\n<brain_dump>\n${BRAIN_DUMP}\n</brain_dump>` },
    ]);
    // The check never sees the brain dump or the drafter's conversation.
    expect(check.system).toBe(CHECK_SYSTEM);
    expect(check.messages).toHaveLength(1);
    expect(check.messages[0]!.content).not.toContain("Honestly I am tired");
    expect(check.messages[0]!.content).toContain("make_the_homepage_font_a_deeper_blue");
    expect(check.messages[0]!.content).not.toContain("summon_a_wizard");

    const candidates = json.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((c) => c.id)).toEqual(["make_the_homepage_font_a_deeper_blue", "draw_the_banner"]);

    const [font, banner] = candidates as [Record<string, any>, Record<string, any>];
    // The review took the palette out of what the font change needs.
    expect(font.in).toEqual({ css: "string" });
    expect(font.review).toEqual({
      agrees: false,
      note: "It edits the stylesheet; it never reads the palette itself.",
      changed: ["in"],
    });
    expect(font.tier).toBe("cheap");
    expect(font.placement).toEqual({
      wave: 3,
      sentence: "Placed in wave 3, after “Write the stylesheet”, which it reads css from.",
    });
    expect(banner.review.agrees).toBe(true);
    expect(banner.placement.sentence).toMatch(/^Placed in wave 1: .*it hands banner to “Publish”\.$/);

    expect(json.duplicates).toEqual([
      { text: "the palette step, someone has to pick it", nodeId: "palette", reason: "That is Pick the palette." },
    ]);
    expect(json.waitingOnYou).toEqual(PARSE.waitingOnYou);
    const setAside = json.setAside as Array<{ text: string; reason: string }>;
    expect(setAside.map((s) => s.text)).toEqual([
      "Honestly I am tired.",
      "a line the model misread",
      "a ghost",
    ]);
  });

  it("sets an invalid candidate aside with the schema's reason, and does not review it", async () => {
    const onlyBad = { ...PARSE, candidates: [PARSE.candidates[2]], duplicates: [] };
    const { client, calls } = fakeClient(message(onlyBad));
    const server = await serveWith(client);
    const { status, json } = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(status).toBe(200);
    expect(json.candidates).toEqual([]);
    const setAside = json.setAside as Array<{ text: string; reason: string }>;
    expect(setAside.find((s) => s.text === "a line the model misread")?.reason).toMatch(
      /^drafted as a step, but it is not a valid step \(kind: /,
    );
    // Nothing valid to check, so the second call is never made.
    expect(calls).toHaveLength(1);
  });

  it("sets aside a candidate that names a field twice", async () => {
    const twice = {
      ...PARSE,
      candidates: [{ ...PARSE.candidates[1], out: [field("banner"), field("banner")] }],
    };
    const { client } = fakeClient(message(twice));
    const server = await serveWith(client);
    const { json } = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    const setAside = json.setAside as Array<{ reason: string }>;
    expect(setAside.some((s) => s.reason.includes("out names 'banner' twice"))).toBe(true);
  });

  it("refuses a candidate that would give a started step a new input", async () => {
    const { client } = fakeClient(message(PARSE), message(CHECK));
    const server = await serveWith(client);
    const { json } = await post(server, {
      brainDump: BRAIN_DUMP,
      spec: SPEC,
      started: ["palette", "stylesheet", "publish"],
    });
    const banner = (json.candidates as Array<Record<string, any>>).find((c) => c.id === "draw_the_banner")!;
    expect(banner.refusal).toMatch(/“Publish” \(banner\).*already started/);
    expect(banner.placement).toBeUndefined();
    // Reading from started work is fine.
    const font = (json.candidates as Array<Record<string, any>>)[0]!;
    expect(font.refusal).toBeUndefined();
  });

  it("reports the linter's findings with each candidate", async () => {
    const rival = {
      ...PARSE,
      candidates: [{ ...PARSE.candidates[0], label: "Rival", in: [field("palette")] }],
    };
    const { client } = fakeClient(message(rival), message({ reviews: [{ ...CHECK.reviews[0], id: "rival", agrees: true }] }));
    const server = await serveWith(client);
    const { json } = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    const findings = (json.candidates as Array<Record<string, any>>)[0]!.findings as Array<{ rule: string }>;
    expect(findings.map((f) => f.rule)).toContain("HIDDEN_EDGE");
  });

  it("is a 404 that says how to turn it on when the server was not started to draft", async () => {
    const server = await serveWith(undefined);
    const { status, json } = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(status).toBe(404);
    expect(json.error).toBe(DRAFTING_OFF);
    expect(String(json.error)).toMatch(/--drafting.*ANTHROPIC_API_KEY/);
  });

  it("keeps CORS to the one origin", async () => {
    const { client } = fakeClient(message(PARSE), message(CHECK));
    const server = await serveWith(client);
    const res = await fetch(`${server.url}/draft`, { method: "OPTIONS" });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3210");
  });

  it("refuses bad requests with a clear reason, before any model call", async () => {
    const { client, calls } = fakeClient();
    const server = await serveWith(client);
    expect((await post(server, "{nope")).status).toBe(400);
    expect((await post(server, { spec: SPEC })).json.error).toBe("brainDump must be some text");
    const long = await post(server, { brainDump: "x".repeat(MAX_BRAIN_DUMP_CHARS + 1), spec: SPEC });
    expect(long.status).toBe(413);
    expect(long.json.error).toMatch(/limit is 20000/);
    const broken = await post(server, { brainDump: BRAIN_DUMP, spec: "nodes: [" });
    expect(broken.status).toBe(400);
    expect(broken.json.error).toMatch(/^the spec does not parse/);
    expect((await post(server, { brainDump: "x", spec: SPEC, started: [1] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("says when the model declines or runs out of room", async () => {
    const { client } = fakeClient(message({}, "refusal"), message({}, "max_tokens"));
    const server = await serveWith(client);
    const declined = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(declined.status).toBe(502);
    expect(declined.json.error).toBe("the model declined to work on this brain dump");
    const long = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(long.json.error).toMatch(/ran out of room/);
  });

  it("never puts the key in a response or a log line", async () => {
    const failure = Object.assign(new Error(`401 invalid x-api-key ${KEY}`), { status: 401 });
    const leaky = Object.assign(new Error(`socket hang up near ${KEY}`), {});
    const log: string[] = [];
    const { client } = fakeClient(failure, leaky, message(PARSE), message(CHECK));
    const server = await serveWith(client, log);

    const refused = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(refused.status).toBe(502);
    expect(refused.json.error).toBe("the API key was refused (HTTP 401)");

    const unknown = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(unknown.json.error).toBe("the model call failed: socket hang up near [redacted]");

    const fine = await post(server, { brainDump: BRAIN_DUMP, spec: SPEC });
    expect(fine.status).toBe(200);

    for (const text of [refused.text, unknown.text, fine.text, ...log]) expect(text).not.toContain(KEY);
    expect(log).toHaveLength(3);
  });
});

describe("ccg serve --drafting", () => {
  it("refuses to start without a key, and says where the key goes", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(serveCommand([dir, "--drafting", "--port", "0"], {})).toBe(2);
    expect(String(stderr.mock.calls[0]![0])).toMatch(/--drafting needs ANTHROPIC_API_KEY/);
  });
});
