// SPDX-License-Identifier: Apache-2.0

/**
 * Undo and redo for edits made from the picture, held as whole spec texts.
 *
 * A step is the text before and after one edit, so undo restores the source
 * exactly as it was, comments and spacing included, rather than a reformatted
 * copy of it.
 *
 * The scope is deliberately narrow. Only edits that go through `edit` are
 * recorded. Anything else that replaces the text (typing in it, loading an
 * example, opening a file, drawing a link) starts a fresh history with
 * `startHistory`: an undo that restored a spec from before the reader's own
 * typing would throw that typing away, and the text area keeps its own undo
 * for what is typed into it.
 */
export interface SpecHistory {
  readonly source: string;
  readonly past: readonly string[];
  readonly future: readonly string[];
}

/** Enough to undo a long session of panel edits; old steps fall off the far end. */
const LIMIT = 100;

export const startHistory = (source: string): SpecHistory => ({ source, past: [], future: [] });

export function edit(history: SpecHistory, next: string): SpecHistory {
  if (next === history.source) return history;
  return { source: next, past: [...history.past, history.source].slice(-LIMIT), future: [] };
}

export function undo(history: SpecHistory): SpecHistory {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    source: previous,
    past: history.past.slice(0, -1),
    future: [history.source, ...history.future],
  };
}

export function redo(history: SpecHistory): SpecHistory {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { source: next, past: [...history.past, history.source], future: rest };
}
