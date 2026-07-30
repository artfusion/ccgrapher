"use client";
// SPDX-License-Identifier: Apache-2.0

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { INK, KIND_TINT } from "../lib/graph-model";

/**
 * Same visual vocabulary as the SVG renderer: agent nodes get a sketchy border,
 * code-only nodes sharp corners to say "this costs nothing", the human gate a
 * dashed one, a fanOut node a stacked card and an ×N badge.
 */
export function SpecNode({ data }: NodeProps) {
  const d = data as {
    lines: string[];
    kind: string;
    style: "agent" | "code" | "human";
    badge: string | null;
    worktree: boolean;
    problems: string[];
  };

  const hasProblem = d.problems.length > 0;

  return (
    <div
      className={`spec-node style-${d.style}${d.worktree ? " worktree" : ""}${hasProblem ? " flagged" : ""}`}
      style={{ background: KIND_TINT[d.kind] ?? "#fff", borderColor: INK }}
      title={hasProblem ? d.problems.join("\n") : undefined}
    >
      <Handle type="target" position={Position.Top} />
      {d.badge && <span className="badge">{d.badge}</span>}
      <span className={`icon icon-${d.kind}`} aria-hidden />
      <span className="label">
        {d.lines.map((line, i) => (
          <span key={i} className="line">
            {line}
          </span>
        ))}
      </span>
      {hasProblem && <span className="warn" aria-label="lint finding" />}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
