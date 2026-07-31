/**
 * The widget registry (04-SPEC-frontend.md 4).
 *
 * Adding a widget type requires touching exactly one new file plus one line here.
 * That constraint is what keeps the grid from growing a switch statement per
 * feature.
 *
 * The config schemas live in `@nexuscentral/shared` so the API validates the same rules
 * these forms produce.
 */

import type { ComponentType } from 'react';
import {
  WIDGET_CONFIG_SCHEMAS,
  WIDGET_GEOMETRY,
  defaultWidgetConfig,
  type WidgetType,
} from '@nexuscentral/shared';
import { AlertsWidget, AlertsConfigForm } from './AlertsWidget.tsx';
import { CustomApiWidget, CustomApiConfigForm } from './CustomApiWidget.tsx';
import { FeedWidget, FeedConfigForm } from './FeedWidget.tsx';
import { SourceHealthWidget, SourceHealthConfigForm } from './SourceHealthWidget.tsx';
import { StatsWidget, StatsConfigForm } from './StatsWidget.tsx';

export interface WidgetBodyProps {
  config: Record<string, unknown>;
  data: unknown;
}

export interface WidgetConfigFormProps {
  value: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export interface WidgetDefinition {
  type: WidgetType;
  /** English, sentence case. */
  labelKey: string;
  descriptionKey: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  defaultConfig: () => Record<string, unknown>;
  ConfigForm: ComponentType<WidgetConfigFormProps>;
  /**
   * Memoised at the definition, not at the call site: without this, dragging one
   * widget re-renders every other body and the drag stutters at around fifteen
   * widgets (04-SPEC-frontend.md 3).
   */
  Body: ComponentType<WidgetBodyProps>;
}

/**
 * Spelled out rather than computed from the type.
 *
 * `widget.${type}.label` would read the same but no test could see it: the copy
 * contract check (test/locales.test.ts) scans for keys as literals, and a computed
 * one shows up as neither used nor verified.
 */
const COPY: Record<WidgetType, { labelKey: string; descriptionKey: string }> = {
  feed: { labelKey: 'widget.feed.label', descriptionKey: 'widget.feed.description' },
  alerts: { labelKey: 'widget.alerts.label', descriptionKey: 'widget.alerts.description' },
  source_health: {
    labelKey: 'widget.source_health.label',
    descriptionKey: 'widget.source_health.description',
  },
  stats: { labelKey: 'widget.stats.label', descriptionKey: 'widget.stats.description' },
  custom_api: {
    labelKey: 'widget.custom_api.label',
    descriptionKey: 'widget.custom_api.description',
  },
};

function define(
  type: WidgetType,
  Body: ComponentType<WidgetBodyProps>,
  ConfigForm: ComponentType<WidgetConfigFormProps>,
): WidgetDefinition {
  return {
    type,
    ...COPY[type],
    ...WIDGET_GEOMETRY[type],
    defaultConfig: () => defaultWidgetConfig(type),
    ConfigForm,
    Body,
  };
}

export const WIDGET_REGISTRY: Partial<Record<WidgetType, WidgetDefinition>> = {
  feed: define('feed', FeedWidget, FeedConfigForm),
  alerts: define('alerts', AlertsWidget, AlertsConfigForm),
  source_health: define('source_health', SourceHealthWidget, SourceHealthConfigForm),
  stats: define('stats', StatsWidget, StatsConfigForm),
  custom_api: define('custom_api', CustomApiWidget, CustomApiConfigForm),
};

export function widgetDefinition(type: WidgetType): WidgetDefinition | undefined {
  return WIDGET_REGISTRY[type];
}

export const AVAILABLE_DEFINITIONS: WidgetDefinition[] = Object.values(WIDGET_REGISTRY).filter(
  (definition): definition is WidgetDefinition => definition !== undefined,
);

/** Re-exported so a config form can validate what it produces before emitting it. */
export { WIDGET_CONFIG_SCHEMAS };
