/**
 * The appearance controls (04-SPEC-frontend.md 5.4).
 *
 * - Mode: a three-way segmented control.
 * - Accent: a hue slider rendered as a live OKLCH gradient, plus preset swatches.
 * - Chroma: two steps labelled Muted / Vivid, not a raw number. Nobody wants to
 *   reason about 0.14.
 *
 * The preview applies immediately and persists on release: dragging a slider must
 * not write to the database sixty times a second.
 */

import { useState, type ReactNode } from 'react';
import { THEME_MODES, THEME_PRESETS, type ThemeMode, type ThemePreset } from '@feedhub/shared';
import { useUpdateSettings } from '../api/queries.ts';
import { useT } from '../i18n.tsx';
import { oklchToHex } from '../lib/oklch.ts';
import { CHROMA_MUTED, CHROMA_VIVID, useThemeStore } from '../theme/store.ts';

/** Eight hues spread around the wheel, all validated by the contrast test. */
const PRESET_HUES = [250, 285, 320, 15, 50, 110, 160, 200];

function hueGradient(chroma: number): string {
  // The slider track shows what each hue actually produces, at the chosen chroma.
  const stops = Array.from({ length: 25 }, (_unused, index) => {
    const hue = index * 15;
    return `${oklchToHex({ l: 0.62, c: chroma, h: hue })} ${(index / 24) * 100}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function AppearancePanel(): ReactNode {
  const t = useT();
  const update = useUpdateSettings();

  const mode = useThemeStore((state) => state.mode);
  const preset = useThemeStore((state) => state.preset);
  const setPreset = useThemeStore((state) => state.setPreset);
  const hue = useThemeStore((state) => state.hue);
  const chroma = useThemeStore((state) => state.chroma);
  const setMode = useThemeStore((state) => state.setMode);
  const setHue = useThemeStore((state) => state.setHue);
  const setChroma = useThemeStore((state) => state.setChroma);
  const previewHue = useThemeStore((state) => state.previewHue);

  const [dragging, setDragging] = useState(false);

  /** A named preset defines its own colours, so the accent controls do nothing. */
  const usesAccent = preset === 'default';

  const commit = (next: {
    themeMode?: ThemeMode;
    themePreset?: ThemePreset;
    accentHue?: number;
    accentChroma?: number;
  }): void => {
    update.mutate(next);
  };

  return (
    <section className="space-y-5">
      <h3 className="text-primary text-base font-semibold">{t('theme.title')}</h3>

      <div>
        <span className="text-secondary mb-1.5 block text-sm">{t('theme.mode.label')}</span>
        <div
          role="radiogroup"
          aria-label={t('theme.mode.label')}
          className="border-subtle inline-flex overflow-hidden rounded border"
        >
          {THEME_MODES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              onClick={() => {
                setMode(option);
                commit({ themeMode: option });
              }}
              className={[
                'px-3 py-1.5 text-sm',
                mode === option
                  ? 'bg-accent text-accent-fg'
                  : 'text-secondary hover:bg-hovered bg-surface',
              ].join(' ')}
            >
              {t(`theme.mode.${option}`)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="text-secondary mb-1.5 block text-sm">{t('theme.preset.label')}</span>
        <div
          role="radiogroup"
          aria-label={t('theme.preset.label')}
          className="flex flex-wrap gap-1.5"
        >
          {THEME_PRESETS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={preset === option}
              onClick={() => {
                // Selecting a dark-native preset switches the mode with it; the
                // store reports what it settled on so both get persisted.
                const applied = setPreset(option);
                commit({ themePreset: option, themeMode: applied.mode });
              }}
              className={[
                'border-subtle rounded border px-3 py-1.5 text-sm',
                preset === option
                  ? 'bg-accent text-accent-fg border-strong'
                  : 'text-secondary hover:bg-hovered bg-surface',
              ].join(' ')}
            >
              {t(`theme.preset.${option}`)}
            </button>
          ))}
        </div>
        <p className="text-muted mt-1.5 text-xs">{t(`theme.preset.${preset}.note`)}</p>
      </div>

      <div aria-disabled={usesAccent ? undefined : true} className={usesAccent ? '' : 'opacity-50'}>
        <label htmlFor="accent-hue" className="text-secondary mb-1.5 block text-sm">
          {t('theme.accent.label', { hue })}
        </label>
        {!usesAccent && (
          // Saying so beats leaving a control that visibly does nothing.
          <p role="status" className="text-muted mb-1.5 text-xs">
            {t('theme.accent.ignoredByPreset', { preset: t(`theme.preset.${preset}`) })}
          </p>
        )}
        <input
          id="accent-hue"
          type="range"
          min={0}
          max={360}
          step={1}
          value={hue}
          onChange={(event) => {
            const next = Number(event.target.value);
            // Live preview across the whole app while dragging.
            if (dragging) previewHue(next);
            else setHue(next);
          }}
          onPointerDown={() => setDragging(true)}
          onPointerUp={(event) => {
            setDragging(false);
            const next = Number((event.target as HTMLInputElement).value);
            setHue(next);
            commit({ accentHue: next });
          }}
          onKeyUp={(event) => {
            const next = Number((event.target as HTMLInputElement).value);
            setHue(next);
            commit({ accentHue: next });
          }}
          className="h-6 w-full cursor-pointer appearance-none rounded"
          style={{ background: hueGradient(chroma) }}
        />

        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRESET_HUES.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={t('theme.accent.preset', { hue: preset })}
              aria-pressed={hue === preset}
              onClick={() => {
                setHue(preset);
                commit({ accentHue: preset });
              }}
              className={[
                'h-7 w-7 rounded-full border-2',
                hue === preset ? 'border-strong' : 'border-subtle',
              ].join(' ')}
              style={{ backgroundColor: oklchToHex({ l: 0.62, c: chroma, h: preset }) }}
            />
          ))}
        </div>
      </div>

      <div>
        <span className="text-secondary mb-1.5 block text-sm">{t('theme.chroma.label')}</span>
        <div
          role="radiogroup"
          aria-label={t('theme.chroma.label')}
          className="border-subtle inline-flex overflow-hidden rounded border"
        >
          {[
            { value: CHROMA_MUTED, key: 'theme.chroma.muted' },
            { value: CHROMA_VIVID, key: 'theme.chroma.vivid' },
          ].map((step) => (
            <button
              key={step.key}
              type="button"
              role="radio"
              aria-checked={chroma === step.value}
              onClick={() => {
                setChroma(step.value);
                commit({ accentChroma: step.value });
              }}
              className={[
                'px-3 py-1.5 text-sm',
                chroma === step.value
                  ? 'bg-accent text-accent-fg'
                  : 'text-secondary hover:bg-hovered bg-surface',
              ].join(' ')}
            >
              {t(step.key)}
            </button>
          ))}
        </div>
      </div>

      {update.error !== null && (
        <p role="alert" className="text-negative text-sm">
          {t('error.generic', { message: update.error.message })}
        </p>
      )}
    </section>
  );
}
