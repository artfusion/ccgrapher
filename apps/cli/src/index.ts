#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { SpecError } from "@ccgrapher/core";
import { lintCommand } from "./commands/lint.js";
import { codegenCommand } from "./commands/codegen.js";
import { ingestCommand } from "./commands/ingest.js";
import { planCommand } from "./commands/plan.js";
import { renderCommand } from "./commands/render.js";
import { retroCommand } from "./commands/retro.js";
import { serveCommand } from "./commands/serve.js";
import { traceCommand } from "./commands/trace.js";

const USAGE = `ccg — graph engineering for agent workflows

Usage:
  ccg lint <spec.yaml>...            find fake edges and wasted sequencing
  ccg render <spec.yaml> -o out.svg  draw the layered graph (svg, mermaid, excalidraw)
  ccg codegen <spec.yaml> -t <target>  emit the matching orchestration code
  ccg ingest <orchestration.ts>        reconstruct a spec from existing code
  ccg plan <spec.yaml>                 what can run at once, wave by wave
  ccg retro <owner/repo>               rebuild the as-merged workflow from a repo's PR history
  ccg serve <trace-dir>                stream a run's trace over SSE
  ccg trace stats <run.jsonl|dir>      summarise a trace's durations and cost

Lint options:
  --json            machine-readable output
  --color           force ANSI colour (default: on when a TTY)
  --quiet           exit code only

Render options:
  -o, --out <file>  write here instead of stdout
  -f, --format <f>  svg | mermaid | excalidraw (default: from the -o extension)
  --fix             render the repaired graph rather than the graph as written
  --plain           do not mark fake edges in red
  --no-header       omit the name/goal caption
  --no-embed-font   reference the handwriting font instead of inlining it
  --no-grain        omit the paper texture (much smaller when rasterised)

Codegen options:
  -o, --out <file>  write here instead of stdout
  -t, --target <t>  claude-code | plain-ts | langgraph (default: claude-code)
  --fix             generate from the repaired graph
  --no-banner       omit the generated-from header comment

Plan options:
  --fix             plan the repaired graph rather than the graph as written
  --json            machine-readable waves, for tooling and agents

Ingest options:
  -o, --out <file>  write the reconstructed spec here
  --name <name>     spec name, if the source does not record one
  --lint            audit the reconstructed graph instead of printing it

Retro options:
  --limit <n>       how many merged PRs to read (default 15, max 50)
  -o, --out <file>  write the reconstructed spec here
  --lint            audit the as-merged graph instead of printing it
  --from-json <f>   build from saved \`gh pr list\` JSON instead of calling gh
  --heat <file>     write a HeatData overlay here, keyed by the same pr_<n> ids
  --metric <m>      pr-duration-hours | pr-size-lines (default: pr-duration-hours)

Serve options:
  --port <n>        0 asks the OS for a free port (default 3211)
  --host <host>     interface to bind (default 127.0.0.1)
  --origin <origin> the one origin CORS allows to read the trace

Trace stats options:
  --json            machine-readable RunStats output
  --heat <file>     write a HeatData overlay here, keyed by node id
  --metric <m>      duration-ms | cost-usd (default: duration-ms)

Exit codes:
  0  clean    1  lint errors found    2  bad usage or unreadable spec
`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "lint":
        return lintCommand(rest);
      case "render":
        return renderCommand(rest);
      case "codegen":
        return codegenCommand(rest);
      case "ingest":
        return ingestCommand(rest);
      case "plan":
        return planCommand(rest);
      case "retro":
        return retroCommand(rest);
      case "serve":
        return serveCommand(rest);
      case "trace":
        return traceCommand(rest);
      default:
        process.stderr.write(`ccg: unknown command '${command}'\n\n${USAGE}`);
        return 2;
    }
  } catch (cause) {
    if (cause instanceof SpecError) {
      process.stderr.write(`${cause.message}\n`);
      return 2;
    }
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      process.stderr.write(`ccg: no such file\n`);
      return 2;
    }
    throw cause;
  }
}

process.exitCode = main(process.argv.slice(2));
