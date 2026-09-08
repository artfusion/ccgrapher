// SPDX-License-Identifier: Apache-2.0

/**
 * Carrying a spec in the URL fragment, so a render pair posted to a ticket can
 * carry an "open live" link with no server round trip and no CORS story.
 *
 * The fragment, not the query string: a fragment never reaches a server log,
 * which matters for a spec someone would rather not have sitting in access
 * logs, and it needs no server cooperation at all — the page reads
 * `location.hash` itself.
 *
 * Base64url rather than plain base64: the alphabet (`A-Za-z0-9-_`) contains
 * nothing a URL fragment ever needs to percent-encode, so the link stays
 * copy-pasteable as one token.
 */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The fragment to append after `#` — does not include the leading `#`. */
export function encodeSpecFragment(source: string): string {
  return `spec=${toBase64Url(new TextEncoder().encode(source))}`;
}

/**
 * Reads a spec out of `location.hash` (or any string in the same shape).
 * `undefined` for a hash with no `spec=` in it, or one that fails to decode —
 * a malformed link should fall back to the ordinary empty editor, not crash it.
 */
export function decodeSpecFragment(hash: string): string | undefined {
  const match = /(?:^|[#&])spec=([^&]+)/.exec(hash);
  if (!match) return undefined;
  try {
    return new TextDecoder().decode(fromBase64Url(match[1]!));
  } catch {
    return undefined;
  }
}

/**
 * Viewer mode is implied by a spec arriving via the URL, or forced with
 * `#view=1` on its own (a link to the default fixture, read-only).
 */
export function isViewerHash(hash: string): boolean {
  return /(?:^|[#&])view=1(?:&|$)/.test(hash) || /(?:^|[#&])spec=/.test(hash);
}
