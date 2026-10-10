// SPDX-License-Identifier: Apache-2.0
import type Anthropic from "@anthropic-ai/sdk";
import type { DraftingClient } from "./drafting.js";

/**
 * A compile-time check and nothing else: no code is emitted from this file.
 *
 * The drafting tests drive a hand-built client, so they would go on passing if
 * the SDK changed the shape of `messages.create`. This line is what notices: if
 * the real client no longer fits `DraftingClient`, `tsc` fails here.
 */
type Holds<T extends true> = T;
export type SdkFitsTheDraftingClient = Holds<Anthropic extends DraftingClient ? true : false>;
