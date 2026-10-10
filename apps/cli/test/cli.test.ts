// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/cli/dist/index.js");
const example = (name: string) => join(root, "examples", `${name}.yaml`);
/** daily-brief broken one way at a time: the fixtures for the rules about what one run hands the next. */
const variant = (name: string) => join(root, "packages/lint/test/fixtures/daily-brief", `${name}.yaml`);
const desk = (name: string) => join(root, "packages/lint/test/fixtures/research-desk", `${name}.yaml`);
const trace = (name: string) => join(root, "examples/traces", `${name}.jsonl`);
const traceDir = () => join(root, "examples/traces");
const out = mkdtempSync(join(tmpdir(), "ccg-cli-"));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * A V8 stack frame: leading whitespace, then `at `.
 *
 * Searching stderr for the bare string "at " looks equivalent and is not: it
 * also matches the last two letters of "format", so an assertion using it
 * fails on the perfectly good message
 * `option '-f, --format <value>' argument missing`.
 */
const STACK_FRAME = /^\s+at /m;

// spawnSync rather than execFileSync: a warning on a successful run is still a
// warning, and execFileSync only hands back stderr when the command failed.
function ccg(...args: string[]): Run {
  const run = spawnSync("node", [cli, ...args], { encoding: "utf8" });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

describe("exit codes", () => {
  it("0 when a spec is clean", () => {
    expect(ccg("lint", example("diamond")).status).toBe(0);
  });

  it("1 when the linter finds errors", () => {
    expect(ccg("lint", example("linear-chain")).status).toBe(1);
  });

  it("0 when there are only warnings", () => {
    expect(ccg("lint", example("self-grading")).status).toBe(0);
  });

  it("2 on bad usage", () => {
    expect(ccg("lint").status).toBe(2);
    expect(ccg("nonsense").status).toBe(2);
  });

  it("2 on an unreadable spec, without a stack trace", () => {
    const run = ccg("lint", join(out, "missing.yaml"));
    expect(run.status).toBe(2);
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });
});

/**
 * An unknown flag is bad usage, so it exits 2. It used to escape parseArgs as
 * a raw TypeError, print a Node stack trace and exit 1 — the code that means
 * "this workflow has lint errors". A mistyped flag was therefore
 * indistinguishable from a failing check to anything reading exit codes,
 * which is exactly what CI does.
 *
 * Every command parses through the same wrapper, so every command is checked
 * here. The point of the fix is that they agree.
 */
describe("an unknown flag is bad usage, not a crash", () => {
  const commands: Array<[string, string[]]> = [
    ["lint", ["lint", example("diamond")]],
    ["render", ["render", example("diamond")]],
    ["codegen", ["codegen", example("diamond")]],
    ["ingest", ["ingest", example("diamond")]],
    ["plan", ["plan", example("diamond")]],
    ["retro", ["retro", "owner/repo"]],
    ["run", ["run", example("diamond")]],
    ["serve", ["serve", out]],
    ["trace stats", ["trace", "stats", out]],
    ["trace audit", ["trace", "audit", trace("capability-unused"), "--spec", example("capability-audit")]],
  ];

  for (const [name, argv] of commands) {
    it(`${name} --nope exits 2, names the flag, and prints no stack trace`, () => {
      const run = ccg(...argv, "--nope");
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("--nope");
      expect(run.stderr).toContain(name);
      expect(run.stderr).not.toMatch(STACK_FRAME);
      expect(run.stderr).not.toContain("ERR_PARSE_ARGS");
    });
  }

  it("a flag given no value is bad usage too", () => {
    const run = ccg("render", example("diamond"), "--format");
    expect(run.status).toBe(2);
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("a value on a boolean flag is bad usage too", () => {
    const run = ccg("lint", example("diamond"), "--json=maybe");
    expect(run.status).toBe(2);
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });
});

/**
 * Asking for help is never bad usage. There is no per-command help, so a
 * subcommand prints the same usage the bare `--help` prints rather than
 * rejecting the flag. This is the first thing someone tries after reading a
 * command on the landing page.
 */
describe("--help after a subcommand", () => {
  for (const name of ["lint", "render", "codegen", "ingest", "plan", "retro", "run", "serve", "trace"]) {
    it(`ccg ${name} --help prints usage and exits 0`, () => {
      const run = ccg(name, "--help");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("ccg lint <spec.yaml>");
      expect(run.stderr).not.toMatch(STACK_FRAME);
    });
  }

  it("ccg retro -h works the same way", () => {
    const run = ccg("retro", "-h");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Usage:");
  });
});

/**
 * Node's parseArgs rejects `--no-x` unless `allowNegative` is set, so every
 * negatable flag the usage text advertises needs a test — they were all
 * silently broken before this.
 */
describe("negatable flags actually parse", () => {
  it("render --no-header", () => {
    const run = ccg("render", example("diamond"), "--no-header");
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(">diamond<");
  });

  it("render --no-embed-font", () => {
    const run = ccg("render", example("diamond"), "--no-embed-font");
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("@font-face");
    expect(run.stdout).not.toContain("SIL Open Font");
  });

  it("render --no-grain", () => {
    const run = ccg("render", example("diamond"), "--no-grain");
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("feTurbulence");
  });

  it("codegen --no-banner", () => {
    const run = ccg("codegen", example("diamond"), "--no-banner");
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("Generated by ccgrapher");
  });

  it("lint --no-color", () => {
    const run = ccg("lint", example("diamond"), "--no-color");
    expect(run.status).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(run.stdout).not.toMatch(/\[/);
  });
});

describe("render", () => {
  it("picks the format from the output extension", () => {
    for (const [ext, marker] of [
      ["svg", "<svg xmlns="],
      ["mmd", "flowchart TD"],
      ["excalidraw", '"type": "excalidraw"'],
      ["html", "<!doctype html>"],
    ] as const) {
      const file = join(out, `diamond.${ext}`);
      expect(ccg("render", example("diamond"), "-o", file).status).toBe(0);
      expect(readFileSync(file, "utf8")).toContain(marker);
    }
  });

  it("html wraps the same svg render would have produced, with pan and zoom", () => {
    const svgFile = join(out, "diamond-plain.svg");
    const htmlFile = join(out, "diamond-plain.html");
    ccg("render", example("diamond"), "-o", svgFile);
    ccg("render", example("diamond"), "-o", htmlFile);

    const svg = readFileSync(svgFile, "utf8");
    const html = readFileSync(htmlFile, "utf8");
    expect(html).toContain(svg);
    // xmlns and the font's OFL notice legitimately contain "http://" as
    // text — only a src/href attribute would mean an actual network request.
    expect(html).not.toMatch(/\bsrc="https?:/);
    expect(html).not.toMatch(/\bhref="https?:/);
  });

  it("--fix renders the repaired graph", () => {
    const before = join(out, "before.svg");
    const after = join(out, "after.svg");
    ccg("render", example("linear-chain"), "-o", before);
    ccg("render", example("linear-chain"), "--fix", "-o", after);

    const width = (f: string) => Number(/width="(\d+)"/.exec(readFileSync(f, "utf8"))![1]);
    // The whole point: repairing turns a tall chain into a wide graph.
    expect(width(after)).toBeGreaterThan(width(before) * 1.5);
  });

  it("rejects an unknown format", () => {
    expect(ccg("render", example("diamond"), "-f", "pdf").status).toBe(2);
  });

  it("--legend numbers the steps in every format, and leaves them off without it", () => {
    const draw = (format: string, ...flags: string[]) => ccg("render", example("diamond"), "-f", format, ...flags).stdout;
    expect(draw("svg")).not.toContain("data-step");
    const svg = draw("svg", "--legend");
    expect(svg).toContain('data-step="2a" data-step-of="worker_1"');
    expect(svg).toContain('<g data-legend="steps">');
    // In HTML the numbers go on the picture and the list is HTML beside it.
    const html = draw("html", "--legend");
    expect(html).toContain('data-step="2a"');
    expect(html).not.toContain("data-legend");
    expect(html).toContain('<span class="number">2a</span><span class="label">worker 1</span>');
    expect(draw("mermaid", "--legend")).toContain("  %% 2a  worker 1 · takes angle; gives claim, source, date");
    expect(draw("excalidraw", "--legend")).toContain('"text": "2a · worker 1 · cheap"');
  });
});

describe("render guards", () => {
  let count = 0;
  const rendered = (...args: string[]) => {
    const file = join(out, `guards-${count++}.svg`);
    expect(ccg("render", ...args, "-o", file).status).toBe(0);
    return readFileSync(file, "utf8");
  };

  /** diamond with its checker's guard removed, written out as a spec. */
  const unguardedDiamond = () => {
    const file = join(out, "diamond-unguarded.yaml");
    writeFileSync(
      file,
      readFileSync(example("diamond"), "utf8").replace(/^ +expects: 5.*\n/m, ""),
      "utf8",
    );
    return file;
  };

  it("draws the count a spec declares", () => {
    const svg = rendered(example("diamond"));
    expect(svg).toContain('data-expects="5"');
    expect(svg).not.toContain("data-guard");
  });

  it("draws the guard lint reports as wrong", () => {
    const svg = rendered(example("release-session"));
    expect(svg).toContain('data-guard="mismatch"');
    expect(svg).toContain("9 ≠ 8");
  });

  it("draws the guard lint reports as missing", () => {
    const svg = rendered(unguardedDiamond());
    expect(svg).toContain('data-guard="missing"');
    expect(svg).toContain("no count guard");
  });

  it("reads the findings from the repaired graph under --fix", () => {
    // release-session's guard is still wrong once its edges are repaired.
    expect(rendered(example("release-session"), "--fix")).toContain('data-guard="mismatch"');
    expect(rendered(example("diamond"), "--fix")).not.toContain("data-guard");
  });

  it("--plain drops every finding mark and keeps the badge", () => {
    const svg = rendered(example("release-session"), "--plain");
    expect(svg).not.toContain("data-guard");
    expect(svg).not.toContain("data-halo");
    expect(svg).not.toContain("data-fake");
    expect(svg).toContain('data-expects="9"');
    expect(svg).toContain(">expects 9<");
  });

  it("marks the same finding in mermaid and excalidraw", () => {
    const mmd = join(out, "release-guard.mmd");
    const excalidraw = join(out, "release-guard.excalidraw");
    ccg("render", example("release-session"), "-o", mmd);
    ccg("render", example("release-session"), "-o", excalidraw);
    expect(readFileSync(mmd, "utf8")).toContain("9 ≠ 8");
    expect(readFileSync(excalidraw, "utf8")).toContain("halo-ci");
  });

  it("lint --json gains one detail key per rule that needs it, and no other", () => {
    const BASE = ["message", "nodes", "phase", "rule", "severity"];
    const DETAIL: Record<string, string[]> = {
      FAKE_EDGE: ["edge"],
      MISSING_INPUT: ["field"],
      HIDDEN_EDGE: ["resource"],
      SELF_GRADING: [],
      CONTEXT_COLLAPSE: ["arriving"],
      SILENT_FAILURE: ["arriving"],
      DUPLICATE_EFFECT: ["effect"],
      EARLY_COMMIT: ["effect", "resource"],
      // Against a person's store; the read-only form carries `boundary` instead.
      AUTHORITY_BREACH: ["resource"],
      // On a shared tier; a shared agent carries `agent`, and both carry both.
      MONOCULTURE: ["tier"],
      TIER_MISMATCH: ["tier"],
    };
    const seen = new Set<string>();
    const specs = [
      ...["release-session", "linear-chain", "self-grading", "wide-fanin"].map(example),
      ...["unguarded-post", "early-commit", "agent-writes-preferences"].map(variant),
      desk("cheap-report"),
    ];
    for (const spec of specs) {
      for (const report of JSON.parse(ccg("lint", spec, "--json").stdout)) {
        for (const f of report.findings as Array<{ rule: string }>) {
          seen.add(f.rule);
          expect(Object.keys(f).sort()).toEqual([...BASE, ...DETAIL[f.rule]!].sort());
        }
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(DETAIL).sort());
  });
});

describe("render: every lint rule has a mark", () => {
  // One example per rule, as written or (for linear-chain's shared file) repaired.
  const CASES: Record<string, { spec: string; fix?: boolean; svg: string; mermaid: string; excalidraw: string }> = {
    FAKE_EDGE: { spec: "linear-chain", svg: 'data-finding="FAKE_EDGE"', mermaid: "-.->", excalidraw: '"strokeStyle": "dashed"' },
    MISSING_INPUT: { spec: "linear-chain", svg: ">no repo<", mermaid: "· no repo", excalidraw: "· no repo" },
    HIDDEN_EDGE: { spec: "linear-chain", fix: true, svg: 'data-link="review_a~review_b"', mermaid: "shares notes/findings.md", excalidraw: '"link-review_a~review_b"' },
    SELF_GRADING: { spec: "self-grading", svg: ">grades own work +1<", mermaid: "· grades own work", excalidraw: "· grades own work" },
    CONTEXT_COLLAPSE: { spec: "wide-fanin", svg: ">200 raw in<", mermaid: "· 200 in, no reduce", excalidraw: "· 200 in, no reduce" },
    SILENT_FAILURE: { spec: "release-session", svg: ">9 ≠ 8<", mermaid: "9 ≠ 8", excalidraw: "9 ≠ 8" },
    AUTHORITY_BREACH: { spec: variant("agent-writes-preferences"), svg: ">writes pref…<", mermaid: "· writes preferences, a person's", excalidraw: "· writes preferences, a person's" },
    DUPLICATE_EFFECT: { spec: variant("unguarded-post"), svg: ">unguarded post:brief-ch…<", mermaid: "· unguarded post:brief-channel", excalidraw: "· unguarded post:brief-channel" },
    MONOCULTURE: { spec: desk("same-agent"), svg: ">same agent: analyst<", mermaid: "· same agent as its work: analyst", excalidraw: "· same agent as its work: analyst" },
    TIER_MISMATCH: { spec: desk("cheap-report"), svg: ">cheap synthesis<", mermaid: "· cheap synthesis of a fan-out", excalidraw: "· cheap synthesis of a fan-out" },
    EARLY_COMMIT: { spec: variant("ordering-edge"), fix: true, svg: ">2 stores too early<", mermaid: "· writes bookmarks, ledger too early", excalidraw: "· writes bookmarks, ledger too early" },
  };
  let count = 0;
  const draw = (ext: string, spec: string, ...flags: string[]) => {
    const file = join(out, `marks-${count++}.${ext}`);
    expect(ccg("render", spec.includes("/") ? spec : example(spec), ...flags, "-o", file).status).toBe(0);
    return readFileSync(file, "utf8");
  };

  it.each(Object.entries(CASES))("%s is drawn in svg, mermaid and excalidraw", (rule, c) => {
    const flags = c.fix ? ["--fix"] : [];
    const svg = draw("svg", c.spec, ...flags);
    expect(svg).toMatch(new RegExp(`data-findings?="[^"]*\\b${rule}\\b`));
    expect(svg).toContain(c.svg);
    expect(draw("mmd", c.spec, ...flags)).toContain(c.mermaid);
    expect(draw("excalidraw", c.spec, ...flags)).toContain(c.excalidraw);
  });

  it("covers every rule the linter has", async () => {
    const { RULE_ORDER } = await import("@ccgrapher/lint");
    expect(Object.keys(CASES).sort()).toEqual([...RULE_ORDER].sort());
  });

  it.each(Object.entries(CASES))("--plain leaves %s off", (rule, c) => {
    const flags = c.fix ? ["--fix", "--plain"] : ["--plain"];
    const svg = draw("svg", c.spec, ...flags);
    expect(svg).not.toMatch(/data-findings?=|data-halo|data-link/);
    expect(svg).not.toContain(c.svg);
    expect(draw("mmd", c.spec, ...flags)).not.toContain("stroke:#C4442E");
    expect(draw("excalidraw", c.spec, ...flags)).not.toContain('"halo-');
  });
});

describe("render --pair", () => {
  const written = (file: string) => readFileSync(file, "utf8");

  it("one spec: writes it as written and repaired", () => {
    const base = join(out, "pair-one.svg");
    const run = ccg("render", example("linear-chain"), "--pair", "-o", base);
    expect(run.status).toBe(0);

    const before = written(join(out, "pair-one-before.svg"));
    const after = written(join(out, "pair-one-after.svg"));
    expect(before).toContain("carries no data");
    expect(after).not.toContain("carries no data");
    expect(after).toContain("linear-chain (repaired)");
    expect(run.stderr).toContain("pair-one-before.svg");
    expect(run.stderr).toContain("pair-one-after.svg");
    expect(run.stderr).toMatch(/6 layers/);
    expect(run.stderr).toMatch(/4 layers/);
  });

  it("two specs: writes each as written, so an added guard shows", () => {
    const before = join(out, "pair-before-spec.yaml");
    const after = join(out, "pair-after-spec.yaml");
    const diamond = readFileSync(example("diamond"), "utf8");
    writeFileSync(before, diamond.replace(/^ +expects: 5.*\n/m, ""), "utf8");
    writeFileSync(after, diamond, "utf8");

    const base = join(out, "pair-two.svg");
    const run = ccg("render", "--pair", before, after, "-o", base);
    expect(run.status).toBe(0);
    expect(written(join(out, "pair-two-before.svg"))).toContain('data-guard="missing"');
    const drawn = written(join(out, "pair-two-after.svg"));
    expect(drawn).not.toContain("data-guard");
    expect(drawn).toContain('data-expects="5"');
    // Two specs are two pictures as written; neither is renamed "(repaired)".
    expect(drawn).not.toContain("(repaired)");
  });

  it("works for every format", () => {
    for (const ext of ["svg", "html", "mmd", "excalidraw"]) {
      const base = join(out, `pair-format.${ext}`);
      expect(ccg("render", example("release-session"), "--pair", "-o", base).status).toBe(0);
      expect(written(join(out, `pair-format-before.${ext}`)).length).toBeGreaterThan(0);
      expect(written(join(out, `pair-format-after.${ext}`)).length).toBeGreaterThan(0);
    }
  });

  it("with --legend, numbers each picture by its own waves", () => {
    const base = join(out, "pair-legend.svg");
    expect(ccg("render", example("release-session"), "--pair", "--legend", "-o", base).status).toBe(0);
    const steps = (file: string) =>
      [...written(file).matchAll(/data-step="([^"]+)" data-step-of="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    const before = steps(join(out, "pair-legend-before.svg"));
    const after = steps(join(out, "pair-legend-after.svg"));
    // As written, a chain of twelve; repaired, five waves, six PRs side by side in the second.
    expect(before).toContain("12 release");
    expect(before).toContain("6 pr_copy");
    expect(after).toContain("5 release");
    expect(after).toContain("3b pr_copy");
    expect(after.filter((s) => s.startsWith("2"))).toHaveLength(6);
    expect(written(join(out, "pair-legend-before.svg"))).toContain('<g data-legend="steps">');
    expect(written(join(out, "pair-legend-after.svg"))).toContain('<g data-legend="steps">');
  });

  it("exits 2 with --fix, without -o, or with more than two specs", () => {
    const base = join(out, "pair-bad.svg");
    const d = example("diamond");
    expect(ccg("render", d, "--pair", "--fix", "-o", base).status).toBe(2);
    expect(ccg("render", d, "--pair").status).toBe(2);
    expect(ccg("render", d, d, d, "--pair", "-o", base).status).toBe(2);
    expect(ccg("render", "--pair", "-o", base).status).toBe(2);
  });

  it("writes nothing when the second spec cannot be read", () => {
    const base = join(out, "pair-missing.svg");
    const run = ccg("render", "--pair", example("diamond"), join(out, "no-such.yaml"), "-o", base);
    expect(run.status).toBe(2);
    expect(existsSync(join(out, "pair-missing-before.svg"))).toBe(false);
  });
});

describe("the ledger", () => {
  const written = (file: string) => readFileSync(file, "utf8");
  const ledgerFixture = (name: string) => join(root, "packages/lint/test/fixtures/ledger", `${name}.yaml`);

  it("diff with one spec compares it with its repair", () => {
    const run = ccg("diff", example("release-session"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("12 to 5 waves, widest wave 1 to 6 steps");
    expect(run.stdout).toContain("ci from wave 11 to wave 4 (7 waves earlier)");
    expect(run.stdout).toContain("12 findings resolved");
  });

  it("diff with two specs finds a guard the repair never adds", () => {
    const run = ccg("diff", ledgerFixture("plan-unguarded"), ledgerFixture("plan-guarded"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("3 count guards added on the fan-ins");
  });

  it("diff --json is the change list as data, the same every time", () => {
    const args = ["diff", ledgerFixture("plan-unguarded"), ledgerFixture("plan-guarded"), "--json"];
    const run = ccg(...args);
    expect(run.status).toBe(0);
    const ledger = JSON.parse(run.stdout);
    expect(ledger.guards.map((g: { id: string }) => g.id)).toEqual(["merge_api", "merge_ui", "release"]);
    expect(ledger.changes).toBe(6);
    expect(ccg(...args).stdout).toBe(run.stdout);
  });

  it("diff of a spec with itself says there are no changes", () => {
    const d = example("diamond");
    expect(ccg("diff", d, d).stdout).toContain("no changes");
    expect(ccg("diff", d).stdout).toContain("no changes");
  });

  it("diff exits 2 with no spec or three", () => {
    const d = example("diamond");
    expect(ccg("diff").status).toBe(2);
    expect(ccg("diff", d, d, d).status).toBe(2);
  });

  it("render --pair --ledger writes a caption file beside two svgs, outside both", () => {
    const base = join(out, "ledger-pair.svg");
    const run = ccg("render", example("release-session"), "--pair", "--ledger", "-o", base);
    expect(run.status).toBe(0);
    const caption = written(join(out, "ledger-pair-ledger.txt"));
    expect(caption).toBe(ccg("diff", example("release-session")).stdout);
    expect(run.stderr).toContain("ledger-pair-ledger.txt");
    expect(written(join(out, "ledger-pair-after.svg"))).not.toContain("waves earlier");
  });

  it("render --pair --ledger in html puts the pair and the changes on one page", () => {
    const base = join(out, "ledger-pair.html");
    const run = ccg(
      "render", "--pair", ledgerFixture("plan-unguarded"), ledgerFixture("plan-guarded"), "--ledger", "-o", base,
    );
    expect(run.status).toBe(0);
    const page = written(join(out, "ledger-pair-ledger.html"));
    expect(page.match(/<svg /g)).toHaveLength(2);
    expect(page).toContain('<h2 id="ledger-heading">Changes</h2>');
    expect(page).toContain("<h3>3 count guards added on the fan-ins</h3>");
    expect(page).toContain("<li>merge_api expects 2 (2 arrive)</li>");
    // The two pages of the pair are written as they always were.
    expect(written(join(out, "ledger-pair-before.html"))).not.toContain("Changes");
  });

  it("--ledger needs --pair", () => {
    expect(ccg("render", example("diamond"), "--ledger", "-o", join(out, "x.svg")).status).toBe(2);
  });
});

describe("the round trip survives the CLI", () => {
  it("codegen then ingest reproduces the spec", () => {
    const ts = join(out, "diamond.ts");
    ccg("codegen", example("diamond"), "-t", "plain-ts", "-o", ts);

    const run = ccg("ingest", ts);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("name: diamond");
    expect(run.stdout).toContain("id: worker_1");
    expect(run.stdout).toContain("source: url");
  });

  it("ingest --lint audits the code rather than the spec", () => {
    const ts = join(out, "chain.ts");
    ccg("codegen", example("linear-chain"), "-t", "plain-ts", "-o", ts);

    const run = ccg("ingest", ts, "--lint");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Critical path: 6 layers -> 4 layers");
  });
});

describe("codegen warns about what the target cannot do", () => {
  it("names the gate the claude-code script will run straight past", () => {
    const run = ccg("codegen", example("research-desk"), "-t", "claude-code");

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("'gate' is a gate");
    expect(run.stderr).toContain("will not wait for approval");
    // The code is still generated: the warning is on the side, as the fake-edge one is.
    expect(run.stdout).toContain('label: "gate"');
  });

  it("says nothing when the spec has no gate", () => {
    expect(ccg("codegen", example("diamond"), "-t", "claude-code").stderr).toBe("");
  });
});

describe("codegen -t managed-agents writes a directory", () => {
  it("writes the agents, the environment and the README", () => {
    const dir = join(out, "managed-agents");
    const run = ccg("codegen", example("research-desk"), "-t", "managed-agents", "-o", dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("managed-agents, 8 files");
    expect(readFileSync(join(dir, "agents/skeptic-correct/agent.md"), "utf8")).toContain('name: "skeptic_correct"');
    expect(existsSync(join(dir, "agents/research-desk/environment.yaml"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("is bad usage without -o, since a directory cannot go to stdout", () => {
    const run = ccg("codegen", example("research-desk"), "-t", "managed-agents");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("writes a directory; pass -o <dir>");
    expect(run.stdout).toBe("");
  });

  it("refuses a directory that is not empty, unless --force", () => {
    const dir = mkdtempSync(join(out, "busy-"));
    writeFileSync(join(dir, "keep.txt"), "mine", "utf8");

    const refused = ccg("codegen", example("research-desk"), "-t", "managed-agents", "-o", dir);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("is not empty; pass --force");
    expect(existsSync(join(dir, "agents"))).toBe(false);

    const forced = ccg("codegen", example("research-desk"), "-t", "managed-agents", "-o", dir, "--force");
    expect(forced.status).toBe(0);
    expect(existsSync(join(dir, "agents/plan/agent.md"))).toBe(true);
    // --force replaces the generated paths and nothing else.
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  it("refuses a path that is a file, even with --force", () => {
    const file = join(out, "not-a-dir.txt");
    writeFileSync(file, "x", "utf8");
    const run = ccg("codegen", example("research-desk"), "-t", "managed-agents", "-o", file, "--force");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("is a file");
  });

  it("names the placeholders it had to write", () => {
    const run = ccg("codegen", example("capability-audit"), "-t", "managed-agents", "-o", join(out, "capability-audit"));
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("YOUR_MCP_URL_DOCS");
    expect(run.stderr).toContain("YOUR_SKILL_ID_SUMMARISE");
  });
});

describe("plan", () => {
  it("collapses waves when the fake edges are repaired", () => {
    const asWritten = ccg("plan", example("release-session"));
    const repaired = ccg("plan", example("release-session"), "--fix");

    expect(asWritten.status).toBe(0);
    // As written it is a staircase: one step per wave.
    expect(asWritten.stdout).toContain("12 waves for 12 steps");
    // Repaired, six of the nine stop waiting on anything.
    expect(repaired.stdout).toContain("5 waves for 12 steps");
    expect(repaired.stdout).toMatch(/×6 together/);
  });

  it("warns that fake edges are inflating the count", () => {
    const run = ccg("plan", example("release-session"));
    expect(run.stdout).toContain("carry no data, inflating this");
    expect(run.stdout).toContain("Real shape is 5");
    // …and says nothing of the sort once repaired.
    expect(ccg("plan", example("release-session"), "--fix").stdout).not.toContain("inflating");
  });

  it("reports honestly when there is no parallelism to find", () => {
    const run = ccg("plan", example("wide-fanin"));
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/together/);
  });

  it("emits machine-readable waves for tooling", () => {
    const run = ccg("plan", example("diamond"), "--json");
    const plan = JSON.parse(run.stdout);
    expect(plan.name).toBe("diamond");
    expect(plan.waveCount).toBe(4);
    const workers = plan.waves.find((w: { concurrent: boolean }) => w.concurrent);
    expect(workers.nodes).toHaveLength(5);
    expect(workers.nodes.map((n: { id: string }) => n.id)).toContain("worker_3");
  });
});

describe("retro", () => {
  const fixture = join(root, "apps/cli/test/fixtures/flowsequencer-prs.json");
  const repo = "artfusion/flowsequencer";

  it("rebuilds the as-merged spec from saved gh output", () => {
    const run = ccg("retro", repo, "--from-json", fixture);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`name: ${repo}`);
    expect(run.stdout).toContain("id: pr_28");
  });

  // The summary and wrote lines are asserted on the --lint run because that is
  // the one that exits 1, which is the behaviour under test here. The harness
  // captures stderr either way now.
  it("--lint audits history rather than printing it", () => {
    const run = ccg("retro", repo, "--from-json", fixture, "--lint");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Critical path: 6 layers -> 3 layers");
    expect(run.stderr).toContain("6 merged PRs");
  });

  it("-o writes the spec", () => {
    const file = join(out, "retro.yaml");
    const run = ccg("retro", repo, "--from-json", fixture, "-o", file, "--lint");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`wrote ${file}`);
    expect(readFileSync(file, "utf8")).toContain("id: pr_25");
  });

  it("2 without a repository", () => {
    expect(ccg("retro").status).toBe(2);
  });

  it("2 on a limit outside 1..50", () => {
    expect(ccg("retro", repo, "--from-json", fixture, "--limit", "0").status).toBe(2);
  });

  it("2 on malformed JSON, without a stack trace", () => {
    const bad = join(out, "bad.json");
    writeFileSync(bad, "not json", "utf8");
    const run = ccg("retro", repo, "--from-json", bad);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("not valid JSON");
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });
});

describe("retro --heat", () => {
  const fixture = join(root, "apps/cli/test/fixtures/flowsequencer-prs.json");
  const repo = "artfusion/flowsequencer";

  it("writes a HeatData file keyed by the same pr_<n> ids as the spec", () => {
    const file = join(out, "retro-heat.json");
    const run = ccg("retro", repo, "--from-json", fixture, "--heat", file);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain(`wrote ${file}`);

    const heat = JSON.parse(readFileSync(file, "utf8"));
    expect(heat.metric).toBe("pr-duration-hours");
    expect(heat.unit).toBe("hours");
    expect(heat.values.pr_30).toBe(28);
    // pr_27 has no createdAt in the fixture — no entry, never a 0.
    expect(heat.values).not.toHaveProperty("pr_27");
  });

  it("--metric pr-size-lines keys by additions + deletions", () => {
    const file = join(out, "retro-heat-size.json");
    const run = ccg("retro", repo, "--from-json", fixture, "--heat", file, "--metric", "pr-size-lines");
    expect(run.status).toBe(0);

    const heat = JSON.parse(readFileSync(file, "utf8"));
    expect(heat.metric).toBe("pr-size-lines");
    expect(heat.unit).toBe("lines");
    expect(heat.values.pr_27).toBe(2);
    // pr_26 has no additions/deletions in the fixture — no entry, never a 0.
    expect(heat.values).not.toHaveProperty("pr_26");
  });

  it("2 on an unknown metric", () => {
    const run = ccg("retro", repo, "--from-json", fixture, "--heat", join(out, "x.json"), "--metric", "bogus");
    expect(run.status).toBe(2);
  });
});

describe("trace stats", () => {
  const fixtures = join(root, "packages/trace/test/fixtures");

  it("prints a duration for every node that recorded one, and a marker for the one that never finished", () => {
    const run = ccg("trace", "stats", join(fixtures, "failed-node.jsonl"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("run-failed");
    expect(run.stdout).toContain("build");
    expect(run.stdout).toContain("12.49s");
    expect(run.stdout).toContain("audit");
    expect(run.stdout).toContain("1.69s");
    // "report" only gets a node_started before run_finished — no duration ever
    // arrived for it, and the summary says so rather than printing a 0.
    expect(run.stdout).toContain("report");
    expect(run.stdout).toContain("no duration recorded");
    expect(run.stdout).not.toMatch(/report.*0ms/);
  });

  it("--json emits RunStats, absent nodes simply missing from it", () => {
    const run = ccg("trace", "stats", join(fixtures, "happy-path.jsonl"), "--json");
    expect(run.status).toBe(0);
    const stats = JSON.parse(run.stdout);
    expect(stats.runIds).toEqual(["run-happy"]);
    expect(stats.nodes.plan).toEqual({ count: 1, meanMs: 1200, medianMs: 1200, costUsd: 0.0021 });
    expect(stats.nodes.write).toEqual({ count: 1, meanMs: 1290, medianMs: 1290 });
  });

  it("--heat duration-ms tints every node with a recorded duration", () => {
    const file = join(out, "trace-heat-duration.json");
    const run = ccg("trace", "stats", join(fixtures, "happy-path.jsonl"), "--heat", file);
    expect(run.status).toBe(0);
    const heat = JSON.parse(readFileSync(file, "utf8"));
    expect(heat).toEqual({
      v: 1,
      metric: "duration-ms",
      unit: "ms",
      source: `ccg trace stats ${join(fixtures, "happy-path.jsonl")}`,
      values: { plan: 1200, research: 2880, write: 1290 },
    });
  });

  it("--heat --metric cost-usd is sparse: only the nodes that actually reported a cost", () => {
    const file = join(out, "trace-heat-cost.json");
    const run = ccg("trace", "stats", join(fixtures, "happy-path.jsonl"), "--heat", file, "--metric", "cost-usd");
    expect(run.status).toBe(0);
    const heat = JSON.parse(readFileSync(file, "utf8"));
    expect(heat.metric).toBe("cost-usd");
    expect(heat.unit).toBe("usd");
    // research and write never reported a cost.
    expect(heat.values).toEqual({ plan: 0.0021 });
  });

  it("aggregates a directory of run files by pooling their instances", () => {
    const run = ccg("trace", "stats", fixtures, "--json");
    expect(run.status).toBe(0);
    const stats = JSON.parse(run.stdout);
    expect(stats.runIds.sort()).toEqual(["run-failed", "run-fanout", "run-gate", "run-happy"]);
    // "worker" only exists in fan-out.jsonl: 3 instances, one of which failed
    // without usage — so 3 durations but only 2 costs feed the aggregate.
    expect(stats.nodes.worker.count).toBe(3);
    expect(stats.nodes.worker.costUsd).toBeCloseTo(0.002, 6);
  });

  it("2 without a path", () => {
    expect(ccg("trace", "stats").status).toBe(2);
  });

  it("2 on an unknown metric", () => {
    const run = ccg(
      "trace",
      "stats",
      join(fixtures, "happy-path.jsonl"),
      "--heat",
      join(out, "x.json"),
      "--metric",
      "bogus",
    );
    expect(run.status).toBe(2);
  });

  it("2 on an unknown trace subcommand", () => {
    expect(ccg("trace", "nonsense").status).toBe(2);
  });
});

describe("trace audit", () => {
  const spec = example("capability-audit");

  // The CI acceptance-criteria shell block's baseline case, ported here so a
  // regression in it surfaces on `pnpm test` rather than only after a full
  // build in CI: a run that declares, reports and uses the same capability
  // has nothing to report at all — not even a warning.
  it("0 with no findings at all when a run's capability use matches its own spec", () => {
    const run = ccg("trace", "audit", trace("live-demo"), "--spec", example("live-demo"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no findings");
  });

  it("0 when the run only disagrees with the spec in ways that are warnings", () => {
    const run = ccg("trace", "audit", trace("capability-unused"), "--spec", spec);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("capability-audit");
    expect(run.stdout).toContain("run cap-unused");
    expect(run.stdout).toContain("UNUSED_CAPABILITY");
    expect(run.stdout).toContain("skill:summarise");
    expect(run.stdout).toContain("1 finding (0 errors, 1 warning)");
  });

  it("1 when a node ran without a capability it declares", () => {
    const run = ccg("trace", "audit", trace("capability-gap"), "--spec", spec);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("CAPABILITY_GAP");
    expect(run.stdout).toContain("write_up");
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("reports the capability a node used but never declared", () => {
    const run = ccg("trace", "audit", trace("capability-undeclared"), "--spec", spec);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("UNDECLARED_CAPABILITY");
    expect(run.stdout).toContain("mcp:web/fetch");
  });

  // Declared-vs-observed at the node level: a node that started before its
  // declared predecessor finished. `ccg run` itself can never produce this —
  // the runner only starts a node once its wave's dependencies are done — so
  // the evidence has to come from a trace it didn't write itself, the way a
  // hooks adapter's timing could disagree with the graph.
  it("1 when a node started before its declared predecessor finished", () => {
    const reordered = join(out, "order-violation.jsonl");
    writeFileSync(
      reordered,
      [
        `{"v":1,"runId":"demo","seq":0,"ts":"2026-09-08T10:00:00.000Z","type":"run_started","spec":{"name":"linear-chain"},"source":"claude-code-hooks"}`,
        `{"v":1,"runId":"demo","seq":1,"ts":"2026-09-08T10:00:00.100Z","type":"node_started","node":"setup"}`,
        // review_a starts while setup is still open — the graph declares setup -> review_a.
        `{"v":1,"runId":"demo","seq":2,"ts":"2026-09-08T10:00:00.900Z","type":"node_started","node":"review_a"}`,
        `{"v":1,"runId":"demo","seq":3,"ts":"2026-09-08T10:00:01.000Z","type":"node_finished","node":"setup","durationMs":900}`,
        `{"v":1,"runId":"demo","seq":4,"ts":"2026-09-08T10:00:01.500Z","type":"node_finished","node":"review_a","durationMs":600}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const run = ccg("trace", "audit", reordered, "--spec", example("linear-chain"));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("ORDER_VIOLATION");
    expect(run.stdout).toContain("review_a started before setup finished");
    expect(run.stdout).toContain("setup -> review_a");
  });

  // A fanned step is finished only when every copy is, and a guarded fan-in
  // that starts short is a finding of its own. Here dedupe starts while the
  // fifth research copy is still running, so both rules fire.
  it("1 when a fan-in started before every copy finished, and short of its guard", () => {
    const early = join(out, "fan-in-shortfall.jsonl");
    const event = (seq: number, body: string) =>
      `{"v":1,"runId":"fan","seq":${seq},"ts":"2026-10-10T10:00:00.000Z",${body}}`;
    writeFileSync(
      early,
      [
        event(0, `"type":"run_started","spec":{"name":"research-desk"},"source":"custom"`),
        event(1, `"type":"node_started","node":"plan"`),
        event(2, `"type":"node_finished","node":"plan","durationMs":10`),
        ...[0, 1, 2, 3, 4].map((i) => event(3 + i, `"type":"node_started","node":"research","instance":${i},"of":5`)),
        ...[0, 1, 2, 3].map((i) => event(8 + i, `"type":"node_finished","node":"research","instance":${i},"durationMs":10`)),
        event(12, `"type":"node_started","node":"dedupe"`),
        "",
      ].join("\n"),
      "utf8",
    );

    const text = ccg("trace", "audit", early, "--spec", example("research-desk"));
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("ORDER_VIOLATION");
    expect(text.stdout).toContain("dedupe started when 4 of 5 copies of research had finished");
    expect(text.stdout).toContain("FAN_IN_SHORTFALL");
    expect(text.stdout).toContain("dedupe started with 4 of the 5 results its 'expects' guard requires");

    const json = ccg("trace", "audit", early, "--spec", example("research-desk"), "--json");
    expect(json.status).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.findings).toContainEqual({
      rule: "FAN_IN_SHORTFALL",
      severity: "error",
      nodes: ["dedupe"],
      message: "dedupe started with 4 of the 5 results its 'expects' guard requires",
    });
  });

  it("--json carries the capability as a field, not only inside the message", () => {
    const run = ccg("trace", "audit", trace("capability-gap"), "--spec", spec, "--json");
    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout);
    expect(report.spec).toBe(spec);
    expect(report.name).toBe("capability-audit");
    expect(report.runIds).toEqual(["cap-gap"]);
    expect(report.findings[0]).toMatchObject({
      rule: "CAPABILITY_GAP",
      severity: "error",
      capability: "skill:summarise",
      nodes: ["write_up"],
    });
  });

  // A clean report over a trace that never reported a capability is not a clean
  // bill of health, and the output has to say which of the two it is.
  // Written here rather than pointed at a committed fixture. This test needs a
  // trace that mentions no capability, and a shared fixture cannot promise that:
  // the live-demo trace it used to use gained capability events from an
  // unrelated change, and the test went from meaningful to wrong without either
  // side touching the other's files.
  it("says so when the trace never mentioned a capability at all", () => {
    // Every diamond node has to start and finish here, or NODE_NEVER_RAN fires
    // for the rest and the "no findings" assertion below stops being true —
    // this test is about the capability-silence message, not the node rules.
    const diamondNodes = ["split", "worker_1", "worker_2", "worker_3", "worker_4", "worker_5", "checker", "merge"];
    let seq = 0;
    const lines = [`{"v":1,"runId":"silent","seq":${seq++},"ts":"2026-08-01T09:00:00.000Z","type":"run_started","spec":{"name":"diamond"},"source":"ccg-run"}`];
    for (const node of diamondNodes) {
      lines.push(`{"v":1,"runId":"silent","seq":${seq++},"ts":"2026-08-01T09:00:01.000Z","type":"node_started","node":"${node}"}`);
      lines.push(`{"v":1,"runId":"silent","seq":${seq++},"ts":"2026-08-01T09:00:02.000Z","type":"node_finished","node":"${node}","durationMs":10}`);
    }
    lines.push(`{"v":1,"runId":"silent","seq":${seq++},"ts":"2026-08-01T09:00:03.000Z","type":"run_finished","ok":true,"durationMs":20}`);

    const silent = join(out, "no-capabilities.jsonl");
    writeFileSync(silent, `${lines.join("\n")}\n`, "utf8");

    const run = ccg("trace", "audit", silent, "--spec", example("diamond"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no findings");
    expect(run.stdout).toContain("no capability events");
  });

  // The pairing the audit used to accept without comment. Two unrelated
  // workflows sharing a node name was all it took to invent a disagreement.
  it("2 when every run in the file came from a different spec", () => {
    const run = ccg("trace", "audit", trace("live-demo"), "--spec", example("capability-audit"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("none came from 'capability-audit'");
    expect(run.stderr).toContain("live-demo");
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("audits the runs that match and says how many it skipped", () => {
    const run = ccg("trace", "audit", traceDir(), "--spec", example("capability-audit"));
    expect(run.stdout).toContain("Skipped 1 run(s) from another spec (live-demo)");
    // The finding that used to leak in from the other spec.
    expect(run.stdout).not.toContain("mcp:docs/fetch");
  });

  it("--json carries provenance and whether anything was checked", () => {
    const run = ccg("trace", "audit", traceDir(), "--spec", example("capability-audit"), "--json");
    const report = JSON.parse(run.stdout) as {
      skipped: Array<{ runId: string; specName: string }>;
      reportedCapabilities: boolean;
    };
    expect(report.skipped).toEqual([{ runId: "live-demo", specName: "live-demo" }]);
    // A consumer reading only the finding count cannot tell clean from unchecked.
    expect(report.reportedCapabilities).toBe(true);
  });

  it("2 without --spec: an audit needs both sides", () => {
    const run = ccg("trace", "audit", trace("capability-gap"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--spec");
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("2 on an unreadable spec, without a stack trace", () => {
    const run = ccg("trace", "audit", trace("capability-gap"), "--spec", join(out, "missing.yaml"));
    expect(run.status).toBe(2);
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("2 without a path", () => {
    expect(ccg("trace", "audit", "--spec", spec).status).toBe(2);
  });
});

describe("help", () => {
  it("lists every command", () => {
    const run = ccg("--help");
    expect(run.status).toBe(0);
    for (const command of ["lint", "render", "codegen", "explain", "ingest", "plan", "retro", "serve", "trace"]) {
      expect(run.stdout).toContain(`ccg ${command}`);
    }
  });
});

describe("explain", () => {
  function explain(name: string, ...flags: string[]): { run: Run; html: string } {
    const file = join(out, `explain-${name}${flags.join("").replace(/[^a-z]/g, "")}.html`);
    const run = ccg("explain", example(name), "-o", file, ...flags);
    return { run, html: existsSync(file) ? readFileSync(file, "utf8") : "" };
  }

  /** The step numbers drawn on the picture, and the ones the list gives, in order. */
  const drawn = (html: string) => [...html.matchAll(/<g data-step="([^"]+)"/g)].map((m) => m[1]);
  const listed = (html: string) => [...html.matchAll(/<li data-step="([^"]+)"/g)].map((m) => m[1]);

  it("writes one page with the three panels", () => {
    const { run, html } = explain("research-desk");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("explain, 9 steps");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>research-desk</h1>");
    expect(html).toContain("decision-grade research on &lt;question&gt;");
    expect(html).toMatch(/<h2 id="loop-heading">.*The full loop<\/h2>/);
    expect(html).toMatch(/<h2 id="steps-heading">.*One run, step by step<\/h2>/);
    expect(html).toMatch(/<h2 id="made-heading">.*What it is made of<\/h2>/);
    // The picture is the one render draws, boundary and all.
    expect(html).toContain("gather and check");
  });

  it("numbers the list exactly as the picture is numbered", () => {
    for (const name of ["research-desk", "release-session", "diamond"]) {
      const { html } = explain(name);
      expect(listed(html).length).toBeGreaterThan(0);
      expect([...listed(html)].sort()).toEqual([...drawn(html)].sort());
    }
  });

  it("lists the one file a one-file target writes", () => {
    const { html } = explain("research-desk");
    expect(html).toContain('<span class="path">research-desk.workflow.mjs</span>');
    expect(html).toContain("the workflow script Claude Code runs: 9 steps in 7 waves");
  });

  it("lists the managed-agents directory as a tree, each agent by its step", () => {
    const { run, html } = explain("research-desk", "-t", "managed-agents");
    expect(run.status).toBe(0);
    expect(html).toContain('<li class="dir"><span class="path">agents/</span>');
    expect(html).toContain('<span class="path">plan/</span>');
    expect(html).toContain('<span class="path">environment.yaml</span>');
    expect(html).toContain("the agent for step 1, plan the angles, on claude-opus-5-5");
    expect(html.match(/<span class="path">agent\.md<\/span>/g)).toHaveLength(6);
  });

  it("lists the findings grouped by rule, and says when the spec is clean", () => {
    expect(explain("research-desk").html).toContain("No findings.");
    const { run, html } = explain("release-session");
    // A page about a spec with errors is still a page written: lint's exit code is lint's.
    expect(run.status).toBe(0);
    expect(html).not.toContain("No findings.");
    expect(html.match(/<code>FAKE_EDGE<\/code>/g)).toHaveLength(1);
    expect(html.match(/<code>MISSING_INPUT<\/code>/g)).toHaveLength(1);
    expect(html).toContain("pr_hotfix -&gt; pr_landing carries nothing");
    expect(html).toContain("ci declares expects: 9 but 8 results actually arrive");
    expect(html).toContain("Critical path: 12 layers as written, 5 once repaired.");
  });

  it("draws the repair beside the spec as written only under --fix, and only when it changes something", () => {
    const plain = explain("release-session").html;
    expect(plain).not.toContain("The repair, before and after");
    expect(plain).toContain("ccg explain --fix</code> draws the repair");

    const fixed = explain("release-session", "--fix").html;
    expect(fixed).toContain("The repair, before and after");
    expect(fixed).toContain("As written: 12 layers");
    expect(fixed).toContain("Repaired: 5 layers");
    // The main picture and its list describe the repaired graph: five waves.
    expect(listed(fixed)).toContain("5");
    expect(listed(fixed)).not.toContain("6");

    const clean = explain("research-desk", "--fix").html;
    expect(clean).not.toContain("The repair, before and after");
    expect(clean).toContain("nothing to repair");
  });

  it("is the same bytes every time", () => {
    const a = ccg("explain", example("release-session"), "--fix", "-t", "managed-agents");
    const b = ccg("explain", example("release-session"), "--fix", "-t", "managed-agents");
    expect(a.status).toBe(0);
    expect(a.stdout.length).toBeGreaterThan(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("asks for nothing over the network", () => {
    for (const html of [explain("release-session", "--fix").html, explain("research-desk", "-t", "managed-agents").html]) {
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toMatch(/<link[^>]/);
      expect(html).not.toMatch(/\b(?:src|href)="(?!#)/);
      expect(html).not.toMatch(/url\((?!data:|#)/);
    }
  });

  it("2 on bad usage", () => {
    expect(ccg("explain").status).toBe(2);
    expect(ccg("explain", example("diamond"), example("diamond")).status).toBe(2);
    expect(ccg("explain", example("diamond"), "-t", "nonsense").status).toBe(2);
    expect(ccg("explain", example("diamond"), "--nonsense").status).toBe(2);
    expect(ccg("explain", join(out, "missing.yaml")).status).toBe(2);
  });
});
