// SPDX-License-Identifier: Apache-2.0
import type Anthropic from "@anthropic-ai/sdk";
import type { ManagedAgentsClient } from "./client.js";

/**
 * A compile-time check and nothing else: no code is emitted from this file.
 *
 * The tests drive a hand-built client, so they would go on passing if the SDK
 * renamed a method this package calls. This line is what notices: if the real
 * client no longer fits `ManagedAgentsClient`, `tsc` fails here.
 */
type Holds<T extends true> = T;
export type SdkFitsTheClientShape = Holds<Anthropic extends ManagedAgentsClient ? true : false>;
