// SPDX-License-Identifier: Apache-2.0
export {
  eventsForHook,
  capabilityForTool,
  capabilitiesIn,
  HOOK_TRACE_SOURCE,
  FALLBACK_SPEC_NAME,
  type HookPayload,
  type HookContext,
} from "./map.js";

export {
  appendHook,
  withTraceLock,
  runIdForSession,
  tracePathFor,
  DEFAULT_RUN_DIR,
  LOCK_RETRIES,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  type AppendOptions,
  type LockOptions,
} from "./append.js";
