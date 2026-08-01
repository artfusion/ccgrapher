"use client";
// SPDX-License-Identifier: Apache-2.0

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodeRunState } from "@ccgrapher/trace";
import { INK, KIND_TINT } from "../lib/graph-model";

/**
 * Same visual vocabulary as the SVG renderer: agent nodes get a sketchy border,
 * code-only nodes sharp corners to say "this costs nothing", the human gate a
 * dashed one, a fanOut node a stacked card and an ×N badge.
 *
 * Run status is a tint on top of that drawing and nothing more. It changes no
 * dimension and no position — see `lib/overlay.ts`.
 */
export function SpecNode({ data }: NodeProps) {
  const d = data as {
    lines: string[];
    kind: string;
    style: "agent" | "code" | "human";
    badge: string | null;
    worktree: boolean;
    problems: string[];
    run?: NodeRunState;
  };

  const hasProblem = d.problems.length > 0;
  const run = d.run;
  const status = run?.status ?? "pending";

  // A fanned node in flight says how far along it is; at rest it says how wide
  // it fans. Same corner, same size, so nothing jumps when the run reaches it.
  const counts = run?.instances;
  const badge =
    counts && (status === "running" || status === "partial")
      ? `${counts.done + counts.failed}/${counts.of}`
      : d.badge;

  return (
    <div
      className={`spec-node style-${d.style}${d.worktree ? " worktree" : ""}${
        hasProblem ? " flagged" : ""
      }${run ? ` run-${status}` : ""}`}
      style={{ background: KIND_TINT[d.kind] ?? "#fff", borderColor: INK }}
      title={[...d.problems, ...runTitle(run)].join("\n") || undefined}
      data-run-status={run ? status : undefined}
    >
      <Handle type="target" position={Position.Top} />
      {badge && <span className="badge">{badge}</span>}
      <span className={`icon icon-${d.kind}`} aria-hidden />
      <span className="label">
        {d.lines.map((line, i) => (
          <span key={i} className="line">
            {line}
          </span>
        ))}
      </span>
      {run && status !== "pending" && <RunMark status={status} />}
      {hasProblem && <span className="warn" aria-label="lint finding" />}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/**
 * The status glyph.
 *
 * Every status carries a shape as well as a colour, and `waiting` carries a word,
 * because the difference that matters most here — nothing is happening, someone
 * is being asked — is exactly the one a colour alone would not make.
 */
function RunMark({ status }: { status: NodeRunState["status"] }) {
  const label = MARK_LABEL[status];
  if (!label) return null;
  return (
    <span className={`run-mark mark-${status}`} role="img" aria-label={label}>
      <span aria-hidden>{MARK_GLYPH[status]}</span>
      {status === "waiting" && <em>waiting on a human</em>}
    </span>
  );
}

const MARK_LABEL: Partial<Record<NodeRunState["status"], string>> = {
  running: "running",
  waiting: "waiting on a human",
  done: "done",
  failed: "failed",
  partial: "some instances still out",
};

const MARK_GLYPH: Partial<Record<NodeRunState["status"], string>> = {
  running: "•",
  waiting: "?",
  done: "✓",
  failed: "✕",
  partial: "•",
};

/** A first read of what the run said. The pop-over that shows all of it comes later. */
function runTitle(run: NodeRunState | undefined): string[] {
  if (!run) return [];
  const lines = [`status: ${run.status}`];
  if (run.durationMs !== undefined) lines.push(`took ${run.durationMs} ms`);
  if (run.instances) {
    lines.push(
      `instances: ${run.instances.done} done, ${run.instances.failed} failed of ${run.instances.of}`,
    );
  }
  if (run.error) lines.push(run.error);
  const tail = run.tail.at(-1);
  if (tail) lines.push(`… ${tail}`);
  return lines;
}
