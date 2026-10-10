// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SLOT_ORDER, renderMarks, type Mark, type MarkSlot } from "../src/marks.js";

const box = { x: 100, y: 200, width: 150, height: 52 };
const mark = (slot: MarkSlot, text: string = slot): Mark => ({ slot, text, fill: "#000" });

describe("node mark slots", () => {
  it("puts each mark in its own corner of the box", () => {
    const svg = renderMarks(
      SLOT_ORDER.map((slot) => mark(slot)),
      box,
    );
    const at = (text: string) => {
      const [, x, y] = new RegExp(`x="([\\d.]+)" y="([\\d.]+)"[^>]*>${text}<`).exec(svg)!;
      return { x: Number(x), y: Number(y) };
    };

    expect(at("top-left").x).toBeLessThan(box.x + box.width / 2);
    expect(at("top-right").x).toBeGreaterThan(box.x + box.width / 2);
    expect(at("bottom-left").x).toBeLessThan(box.x + box.width / 2);
    expect(at("bottom-right").x).toBeGreaterThan(box.x + box.width / 2);
    expect(at("top-left").y).toBeLessThan(box.y + box.height / 2);
    expect(at("bottom-left").y).toBeGreaterThan(box.y + box.height / 2);
    // Every anchor sits inside the box.
    for (const slot of SLOT_ORDER) {
      expect(at(slot).x).toBeGreaterThan(box.x);
      expect(at(slot).x).toBeLessThan(box.x + box.width);
      expect(at(slot).y).toBeGreaterThan(box.y);
      expect(at(slot).y).toBeLessThan(box.y + box.height);
    }
  });

  it("draws in slot order whatever order the marks arrive in", () => {
    const shuffled = [mark("bottom-right"), mark("top-left"), mark("bottom-left"), mark("top-right")];
    expect(renderMarks(shuffled, box)).toBe(renderMarks([...shuffled].reverse(), box));
    const order = [...renderMarks(shuffled, box).matchAll(/>([a-z-]+)</g)].map((m) => m[1]);
    expect(order).toEqual([...SLOT_ORDER]);
  });

  it("refuses two marks in one slot rather than drawing them on top of each other", () => {
    expect(() => renderMarks([mark("bottom-right", "a"), mark("bottom-right", "b")], box)).toThrow(
      /bottom-right/,
    );
  });

  it("escapes what it is given", () => {
    expect(renderMarks([mark("top-left", "<b>&")], box)).toContain("&lt;b&gt;&amp;");
  });
});
