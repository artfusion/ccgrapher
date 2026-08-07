// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/cli/dist/index.js");
const example = (name: string) => join(root, "examples", `${name}.yaml`);
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
    expect(run.stderr).not.toContain("at ");
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
    ] as const) {
      const file = join(out, `diamond.${ext}`);
      expect(ccg("render", example("diamond"), "-o", file).status).toBe(0);
      expect(readFileSync(file, "utf8")).toContain(marker);
    }
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

describe("help", () => {
  it("lists every command", () => {
    const run = ccg("--help");
    expect(run.status).toBe(0);
    for (const command of ["lint", "render", "codegen", "ingest", "plan", "retro", "serve", "trace"]) {
      expect(run.stdout).toContain(`ccg ${command}`);
    }
  });
});
