// SPDX-License-Identifier: Apache-2.0

/**
 * What `@anthropic-ai/sdk` resolves to under vitest: a module that refuses to
 * load. vitest.config.ts aliases the package here for every test, whoever
 * imports it, so a test that somehow found credentials and took the live path
 * would fail on the import instead of opening a session on a real account.
 * Tests that drive `ccg run --managed-agents` hand in a mocked client, and one
 * test of the real constructor path asserts that it meets this wall.
 */
throw new Error("the Anthropic SDK is disabled in tests: pass a mocked client");
