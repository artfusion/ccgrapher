// SPDX-License-Identifier: Apache-2.0

/**
 * The one place a model tier becomes a model. A spec says `cheap` or `strong`;
 * which family that means is decided here, once, and each target renders the
 * family in its own vocabulary: the claude-code target as the short alias its
 * `agent()` call takes, the managed-agents target as the full model id an agent
 * definition needs. When the models move on, this file changes and nothing else.
 */
export type Tier = "cheap" | "strong";
export type ModelFamily = "haiku" | "opus";

export const TIER_FAMILY: Readonly<Record<Tier, ModelFamily>> = {
  cheap: "haiku",
  strong: "opus",
};

/** Full model ids, for targets that cannot take an alias. */
export const MODEL_ID: Readonly<Record<ModelFamily, string>> = {
  haiku: "claude-haiku-5-5",
  opus: "claude-opus-5-5",
};

export const familyOf = (tier: Tier): ModelFamily => TIER_FAMILY[tier];
export const modelIdOf = (tier: Tier): string => MODEL_ID[familyOf(tier)];
