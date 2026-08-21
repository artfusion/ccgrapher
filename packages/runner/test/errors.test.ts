// SPDX-License-Identifier: Apache-2.0

/**
 * `messageOf` exists because an executor is other people's code and may
 * reject with anything at all, not only an `Error`. `execute.test.ts` covers
 * node failure as a whole, but every node it fails throws a real `Error`, so
 * the three branches this function has for everything else were unexercised.
 */

import { describe, expect, it } from "vitest";
import { messageOf } from "../src/errors.js";

describe("messageOf", () => {
  it("takes an Error's own message, not its stringified form", () => {
    expect(messageOf(new Error("disk full"))).toBe("disk full");
  });

  it("passes a string straight through", () => {
    expect(messageOf("disk full")).toBe("disk full");
  });

  it("renders a plain object as JSON rather than the useless '[object Object]'", () => {
    expect(messageOf({ code: "ENOSPC", path: "/tmp" })).toBe('{"code":"ENOSPC","path":"/tmp"}');
  });

  it("falls back to String() for a value JSON.stringify turns into undefined", () => {
    // JSON.stringify(undefined) is undefined, not a throw — the `?? String(error)`
    // branch, not the `catch` branch.
    expect(messageOf(undefined)).toBe("undefined");
  });

  it("falls back to String() when JSON.stringify itself throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(messageOf(circular)).toBe(String(circular));
  });
});
