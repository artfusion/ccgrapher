"use client";
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { LAYERS, type LayerId } from "../lib/layers";
import {
  applyToDocument,
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type Density,
  type Preferences,
  type Theme,
} from "../lib/preferences";

/**
 * The reader's preferences, applied and remembered.
 *
 * Starts at the defaults so the server-rendered page and the first client render
 * agree, then reads storage after mount (the layout's boot script has already
 * set the theme attribute, so a dark reader never sees the paper first).
 */
export function usePreferences(): readonly [Preferences, (next: Preferences) => void] {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    setPrefs(loadPreferences());
  }, []);

  const update = useCallback((next: Preferences) => {
    setPrefs(next);
    applyToDocument(next);
    savePreferences(next);
  }, []);

  useEffect(() => {
    applyToDocument(prefs);
  }, [prefs]);

  return [prefs, update] as const;
}

/**
 * Layers, theme and density. None of it reaches the spec, the layout or the
 * lint result: layers filter the marks on the way to the canvas, theme and
 * density are attributes on the page.
 */
export function ViewBar({
  prefs,
  onChange,
}: {
  prefs: Preferences;
  onChange: (next: Preferences) => void;
}) {
  const setLayer = (id: LayerId, on: boolean) =>
    onChange({ ...prefs, layers: { ...prefs.layers, [id]: on } });

  return (
    <div className="controls view" role="group" aria-label="view">
      <span className="view-label">show</span>
      {LAYERS.map(({ id, label, hint }) => (
        <label key={id} title={hint}>
          <input
            type="checkbox"
            checked={prefs.layers[id]}
            onChange={(e) => setLayer(id, e.target.checked)}
          />
          {label}
        </label>
      ))}

      <span className="view-spacer" />

      <label>
        theme
        <select
          aria-label="theme"
          value={prefs.theme}
          onChange={(e) => onChange({ ...prefs, theme: e.target.value as Theme })}
        >
          <option value="system">follow the system</option>
          <option value="light">paper</option>
          <option value="dark">ink</option>
        </select>
      </label>

      <label>
        density
        <select
          aria-label="density"
          value={prefs.density}
          onChange={(e) => onChange({ ...prefs, density: e.target.value as Density })}
        >
          <option value="comfortable">comfortable</option>
          <option value="compact">compact</option>
        </select>
      </label>
    </div>
  );
}
