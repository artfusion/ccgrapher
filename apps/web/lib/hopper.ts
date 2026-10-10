// SPDX-License-Identifier: Apache-2.0
import type { NodeSpec, WorkflowSpec } from "@ccgrapher/core";
import { checkCandidate, type CandidateCheck, type Started } from "@ccgrapher/lint";
import type { RunState } from "@ccgrapher/trace";
import type { Model } from "./graph-model.js";

/**
 * The hopper's side of drafting: the wire to `ccg serve --drafting`, and what
 * the canvas does with a parse once it has one.
 *
 * The canvas never holds a key and never calls a model. It posts the brain
 * dump and the spec to the local server, which does both (see the CLI's
 * drafting.ts), and gets back a parse. From then on everything happens here,
 * with the same core and lint packages the CLI uses: each candidate is checked
 * again against the spec and the run as they are when it is accepted, because
 * both may have moved since it was drafted.
 */

// ── the wire, as `POST /draft` answers it ─────────────────────────────────

export interface DraftFinding {
  readonly rule: string;
  readonly severity: string;
  readonly message: string;
}

export interface DraftCandidate {
  readonly id: string;
  readonly label: string;
  readonly kind: NodeSpec["kind"];
  readonly tier: "cheap" | "strong" | null;
  readonly in: Readonly<Record<string, string>>;
  readonly out: Readonly<Record<string, string>>;
  readonly writes: readonly string[];
  readonly rationale: string;
  readonly source: string;
  readonly review: { readonly agrees: boolean; readonly note: string; readonly changed: readonly string[] };
  readonly placement?: { readonly wave: number; readonly sentence: string };
  readonly findings: readonly DraftFinding[];
  readonly refusal?: string;
}

export interface DraftResponse {
  readonly model: string;
  readonly candidates: readonly DraftCandidate[];
  readonly duplicates: ReadonlyArray<{ readonly text: string; readonly nodeId: string; readonly reason: string }>;
  readonly waitingOnYou: ReadonlyArray<{
    readonly text: string;
    readonly kind: "question" | "decision";
    readonly recommendation: string;
  }>;
  readonly setAside: ReadonlyArray<{ readonly text: string; readonly reason: string }>;
}

export type DraftOutcome =
  | { readonly kind: "parsed"; readonly response: DraftResponse }
  /** The server answered, and drafting is not turned on there. */
  | { readonly kind: "off" }
  /** Nothing answered at that address. */
  | { readonly kind: "unreachable" }
  | { readonly kind: "error"; readonly message: string };

/** How to turn drafting on, said the same way wherever it is said. */
export const ENABLE_DRAFTING =
  "Drafting runs in the local server, which holds the API key; the canvas never sees one. " +
  "Start it with ccg serve <dir> --drafting and ANTHROPIC_API_KEY in its environment.";

export async function postDraft(
  serverUrl: string,
  body: { brainDump: string; spec: string; started?: readonly string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<DraftOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${serverUrl}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (res.status === 404) return { kind: "off" };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { kind: "error", message: `the server answered ${res.status} with something that is not JSON` };
  }
  if (!res.ok) {
    const error = (json as { error?: unknown } | null)?.error;
    return { kind: "error", message: typeof error === "string" ? error : `the server answered ${res.status}` };
  }
  return { kind: "parsed", response: json as DraftResponse };
}

// ── the canvas's side ───────────────────────────────────────────────────────

export type ItemStatus = "pending" | "accepted" | "rejected";

/** One candidate as the hopper holds it: the step, editable, and what became of it. */
export interface HopperItem {
  readonly candidate: DraftCandidate;
  /** The step itself. Starts as drafted; the inspector edits this, not the spec. */
  readonly node: NodeSpec;
  readonly status: ItemStatus;
  /** Why it was rejected: the check's refusal, a refusal at accept time, or the reader's call. */
  readonly reason?: string;
  /** Where it went and why, once accepted. */
  readonly narration?: string;
}

/** The step a candidate describes, in the spec's own shape. */
export function candidateNode(candidate: DraftCandidate): NodeSpec {
  return {
    id: candidate.id,
    label: candidate.label,
    kind: candidate.kind,
    model: candidate.tier,
    in: { ...candidate.in },
    out: { ...candidate.out },
    ...(candidate.writes.length > 0 ? { writes: [...candidate.writes] } : {}),
  };
}

/** A parse as items. A candidate the check refused arrives rejected, with its reason. */
export function itemsFrom(response: DraftResponse): HopperItem[] {
  return response.candidates.map((candidate) => ({
    candidate,
    node: candidateNode(candidate),
    status: candidate.refusal ? "rejected" : "pending",
    ...(candidate.refusal ? { reason: candidate.refusal } : {}),
  }));
}

/** Steps a run has started or finished: facts, which a placement never touches. */
export function startedSteps(run: RunState | undefined): Started {
  const started = new Set<string>();
  if (!run) return started;
  for (const [id, state] of run.nodes) if (state.status !== "pending") started.add(id);
  return started;
}

/**
 * What an item is now. An accepted step that is no longer in the spec was
 * taken back by an undo, and is pending again rather than claiming a place it
 * does not have.
 */
export function statusOf(item: HopperItem, spec: WorkflowSpec): ItemStatus {
  if (item.status === "accepted" && !spec.nodes.some((n) => n.id === item.node.id)) return "pending";
  return item.status;
}

/** The check, run against the spec and the run as they are now. */
export function checkNow(spec: WorkflowSpec, item: HopperItem, started: Started): CandidateCheck {
  return checkCandidate(spec, item.node, started);
}

/**
 * The spec with every pending candidate that can be placed added to it, in
 * order: what the canvas draws while the ghosts are shown. A candidate that
 * cannot be placed is left out of the picture; its card says why.
 */
export function withGhosts(
  spec: WorkflowSpec,
  items: readonly HopperItem[],
  started: Started,
): { spec: WorkflowSpec; ghosts: Set<string> } {
  let next = spec;
  const ghosts = new Set<string>();
  for (const item of items) {
    if (statusOf(item, spec) !== "pending") continue;
    const check = checkCandidate(next, item.node, started);
    if (check.spec) {
      next = check.spec;
      ghosts.add(item.node.id);
    }
  }
  return { spec: next, ghosts };
}

/** Ink for what is drafted and not yet in the spec: pencil, not pen. */
const GHOST_INK = "#8A817A";

/**
 * Marks the drafted steps in a laid-out model, and the edges that reach them,
 * so the canvas draws them as provisional. Flags and styles only: like every
 * overlay, it moves nothing that layout placed.
 */
export function markGhosts(model: Model, ghosts: ReadonlySet<string>): Model {
  return {
    ...model,
    nodes: model.nodes.map((n) => (ghosts.has(n.id) ? { ...n, data: { ...n.data, ghost: true } } : n)),
    edges: model.edges.map((e) =>
      ghosts.has(e.source) || ghosts.has(e.target)
        ? {
            ...e,
            className: "edge-ghost",
            style: { ...e.style, stroke: GHOST_INK, strokeDasharray: "3 5" },
            labelStyle: { ...e.labelStyle, fill: GHOST_INK },
            markerEnd: { type: "arrowclosed", color: GHOST_INK },
            data: { ...e.data, ghost: true },
          }
        : e,
    ),
  };
}

/**
 * The spec to edit a drafted step in: the spec with that step placed, or, when
 * it cannot be placed (a loop, a started step it would rewire), with the step
 * alone and no edges, so the inspector can still open it and the fix can be
 * made there.
 */
export function specForEditing(spec: WorkflowSpec, item: HopperItem, started: Started): WorkflowSpec {
  return checkCandidate(spec, item.node, started).spec ?? { ...spec, nodes: [...spec.nodes, item.node] };
}
