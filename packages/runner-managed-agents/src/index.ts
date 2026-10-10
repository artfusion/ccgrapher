// SPDX-License-Identifier: Apache-2.0
export { managedAgents, type ManagedAgents, type ManagedAgentsOptions } from "./executor.js";
export { LockError, parseLock, resolveIds, type ClaudeLock, type ResolvedIds } from "./lock.js";
export { CREDENTIAL_VARIABLES, clientFromEnvironment, readLock } from "./environment.js";
export { OutputError, PROTOCOL, inputMessage, nodeInput, readOutput, type NodeInput } from "./protocol.js";
export type {
  ManagedAgentsClient,
  SendEvent,
  SessionBudget,
  SessionCreateParams,
  SessionEvent,
  SessionSnapshot,
} from "./client.js";
export type { SdkFitsTheClientShape } from "./sdk-shape.js";
