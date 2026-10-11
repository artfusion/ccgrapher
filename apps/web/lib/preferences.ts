// SPDX-License-Identifier: Apache-2.0
import { ALL_LAYERS, LAYERS, type Layers } from "./layers";

/**
 * How the reader likes the canvas: which marks, which theme, how tight.
 *
 * Kept in this browser's localStorage and nowhere else. It is not in the spec,
 * not in an export and not in a share link, because none of it is a claim about
 * the work. Every read and write is wrapped, since storage can be absent,
 * blocked or full (a private window, a locked-down embed), and the canvas has to
 * look right without it.
 */
export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

export interface Preferences {
  readonly layers: Layers;
  readonly theme: Theme;
  readonly density: Density;
}

export const STORAGE_KEY = "ccgrapher.view";

export const DEFAULT_PREFERENCES: Preferences = {
  layers: ALL_LAYERS,
  theme: "system",
  density: "comfortable",
};

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const DENSITIES: readonly Density[] = ["comfortable", "compact"];

/** Anything that is not a recognised value falls back to the default for that field. */
export function parsePreferences(raw: string | null | undefined): Preferences {
  if (!raw) return DEFAULT_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;
  const o = value as Record<string, unknown>;
  const stored =
    typeof o.layers === "object" && o.layers !== null ? (o.layers as Record<string, unknown>) : {};
  const layers = Object.fromEntries(
    LAYERS.map(({ id }) => [id, typeof stored[id] === "boolean" ? stored[id] : true]),
  ) as unknown as Layers;
  return {
    layers,
    theme: THEMES.find((t) => t === o.theme) ?? DEFAULT_PREFERENCES.theme,
    density: DENSITIES.find((d) => d === o.density) ?? DEFAULT_PREFERENCES.density,
  };
}

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadPreferences(): Preferences {
  try {
    return parsePreferences(storage()?.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: Preferences): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered; still applied for this visit.
  }
}

/** The attributes `globals.css` keys the theme and density off, on `<html>`. */
export function applyToDocument(prefs: Preferences, root: HTMLElement = document.documentElement) {
  if (prefs.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", prefs.theme);
  root.setAttribute("data-density", prefs.density);
}

/**
 * Runs before first paint (inlined in the layout), so a dark reader does not see
 * a flash of paper. Mirrors `loadPreferences` for the two attributes it sets.
 */
export const BOOT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)})||"{}"),r=document.documentElement;if(p.theme==="light"||p.theme==="dark")r.setAttribute("data-theme",p.theme);if(p.density==="compact")r.setAttribute("data-density","compact")}catch(e){}`;
