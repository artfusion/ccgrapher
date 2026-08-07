// SPDX-License-Identifier: Apache-2.0
/**
 * run-clean.yaml with a `capabilities` export that is not an array of ids.
 *
 * A string is the plausible mistake, and iterating it would report six
 * one-character capabilities as available — a lie in the one place the contract
 * exists to be trusted. It is bad usage, caught before anything runs.
 */

export const capabilities = "mcp:docs/fetch";

export async function alpha() {
  return { output: { seed: "s" } };
}

export async function beta() {
  return { output: { body: "# body" } };
}

export async function gamma() {
  return { output: { page: 1 } };
}
