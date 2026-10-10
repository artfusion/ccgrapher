// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { edit, redo, startHistory, undo } from "../lib/spec-history";

describe("the inspector's undo history", () => {
  it("undoes and redoes one edit at a time, back to the exact text", () => {
    let h = startHistory("a");
    h = edit(h, "b");
    h = edit(h, "c");
    expect(undo(h).source).toBe("b");
    expect(undo(undo(h)).source).toBe("a");
    expect(redo(undo(undo(h))).source).toBe("b");
  });

  it("drops the redo branch on a new edit, and ignores an edit that changes nothing", () => {
    let h = edit(edit(startHistory("a"), "b"), "c");
    h = edit(undo(h), "d");
    expect(h.future).toEqual([]);
    expect(h.past).toEqual(["a", "b"]);
    expect(edit(h, "d")).toBe(h);
  });

  it("does nothing at either end", () => {
    const h = startHistory("a");
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
