// SPDX-License-Identifier: Apache-2.0
import { managedAgentsLayout } from "@ccgrapher/codegen";
import type { Graph } from "@ccgrapher/core";

/**
 * `claude-lock.json`, as `ant apply` writes it: each resource's id under its
 * file's path, the path as the plan printed it (`./agents/plan/agent.md`).
 * Only `id` is read. Whatever else an entry holds is the CLI's business.
 */
export interface ClaudeLock {
  readonly resources: Readonly<Record<string, { readonly id: string }>>;
}

/** The ids one run needs: an agent per model node, and the workflow's environment. */
export interface ResolvedIds {
  readonly agents: ReadonlyMap<string, string>;
  readonly environment: string;
}

/** The lock file is unreadable, or does not cover the spec. Reported before any session exists. */
export class LockError extends Error {
  override readonly name = "LockError";
}

/** Checks the parsed JSON has the one shape this package reads, rather than trusting it. */
export function parseLock(value: unknown, where = "claude-lock.json"): ClaudeLock {
  const resources = (value as { resources?: unknown } | null)?.resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
    throw new LockError(`${where} has no 'resources' object, so it is not a lock file ant apply wrote`);
  }
  const bad = Object.entries(resources).filter(
    ([, entry]) => typeof (entry as { id?: unknown } | null)?.id !== "string",
  );
  if (bad.length > 0) {
    throw new LockError(`${where}: ${bad.map(([path]) => path).join(", ")} ${bad.length === 1 ? "has" : "have"} no string 'id'`);
  }
  return { resources: resources as ClaudeLock["resources"] };
}

/**
 * Pairs every model node with its agent id, by the path the codegen target
 * wrote its file to, and finds the environment the same way.
 *
 * Keys are compared with any leading `./` removed, so the lock must have been
 * written from the generated directory itself: that is where its README says to
 * run `ant apply`. Every node the lock does not cover is named at once, before
 * anything is created, since a run that found out halfway would already have
 * paid for the sessions before it.
 */
export function resolveIds(graph: Graph, lock: ClaudeLock): ResolvedIds {
  const layout = managedAgentsLayout(graph);
  const byPath = new Map(Object.entries(lock.resources).map(([path, entry]) => [path.replace(/^\.\//, ""), entry.id]));

  const agents = new Map<string, string>();
  const missing: string[] = [];
  for (const [node, path] of layout.agents) {
    const id = byPath.get(path);
    if (id === undefined) missing.push(`${node} (${path})`);
    else agents.set(node, id);
  }
  const environment = byPath.get(layout.environment);
  if (environment === undefined) missing.push(`the environment (${layout.environment})`);

  if (missing.length > 0) {
    throw new LockError(
      `claude-lock.json has no id for ${missing.length} file(s): ${missing.join(", ")}. ` +
        `Apply those files by name from the generated directory, so the lock is written beside them.`,
    );
  }
  return { agents, environment: environment! };
}
