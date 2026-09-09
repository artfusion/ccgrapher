// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { decodeSpecFragment, encodeSpecFragment, isViewerHash } from "../lib/viewer-link";

describe("encodeSpecFragment / decodeSpecFragment", () => {
  it("round-trips a plain spec", () => {
    const source = "version: 1\nname: diamond\n";
    expect(decodeSpecFragment(`#${encodeSpecFragment(source)}`)).toBe(source);
  });

  it("round-trips unicode content", () => {
    const source = 'name: "café — 迷路"\n';
    expect(decodeSpecFragment(`#${encodeSpecFragment(source)}`)).toBe(source);
  });

  it("produces a fragment with no character a URL would need to percent-encode", () => {
    const source = "goal: \"a very / weird + string == with symbols\"\n".repeat(20);
    const fragment = encodeSpecFragment(source);
    expect(fragment).toMatch(/^spec=[A-Za-z0-9_-]+$/);
  });

  it("returns undefined for a hash with no spec in it", () => {
    expect(decodeSpecFragment("")).toBeUndefined();
    expect(decodeSpecFragment("#view=1")).toBeUndefined();
  });

  it("returns undefined for a spec value that fails to decode, rather than throwing", () => {
    expect(decodeSpecFragment("#spec=not-valid-base64!!!")).toBeUndefined();
  });

  it("reads spec= alongside other hash params, in either order", () => {
    const source = "name: x\n";
    const encoded = encodeSpecFragment(source);
    expect(decodeSpecFragment(`#view=1&${encoded}`)).toBe(source);
    expect(decodeSpecFragment(`#${encoded}&view=1`)).toBe(source);
  });
});

describe("isViewerHash", () => {
  it("is true once a spec is present", () => {
    expect(isViewerHash(`#${encodeSpecFragment("name: x\n")}`)).toBe(true);
  });

  it("is true for an explicit #view=1 with no spec", () => {
    expect(isViewerHash("#view=1")).toBe(true);
  });

  it("is false for an empty or unrelated hash", () => {
    expect(isViewerHash("")).toBe(false);
    expect(isViewerHash("#something-else")).toBe(false);
  });
});
