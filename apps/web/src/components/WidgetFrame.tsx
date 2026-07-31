/**
 * The chrome around a widget body: title, actions, internal scroll, error boundary.
 *
 * Two things here are load-bearing:
 *
 * 1. **The body scrolls, the frame does not resize.** A fixed grid cell with an
 *    internal scrollbar is what keeps the layout stable (04-SPEC-frontend.md 3).
 * 2. **One broken widget must never blank the dashboard.** Each frame is its own
 *    error boundary, so a body that throws renders an inline message and its
 *    neighbours keep working.
 */

import { Component, memo, type ErrorInfo, type ReactNode } from 'react';
import type { ApiError, Widget } from '@nexuscentral/shared';
import { useT, type Translate } from '../i18n.tsx';
import { widgetDefinition } from '../widgets/registry.tsx';

interface BoundaryProps {
  children: ReactNode;
  fallback: (error: Error, retry: () => void) => ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * A class component because that is still the only way to catch a render error.
 */
export class WidgetErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept, not swallowed: a widget that throws is a bug worth seeing in the
    // console even though the UI degrades gracefully.
    // eslint-disable-next-line no-console
    console.error('Widget crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return this.props.fallback(error, () => this.setState({ error: null }));
    }
    return this.props.children;
  }
}

function WidgetError({
  message,
  onRetry,
  t,
}: {
  message: string;
  onRetry: () => void;
  t: Translate;
}): ReactNode {
  return (
    <div role="alert" className="text-sm">
      <p className="text-negative">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="border-subtle text-secondary hover:bg-hovered mt-2 rounded border px-2 py-0.5 text-xs"
      >
        {t('common.retry')}
      </button>
    </div>
  );
}

export interface WidgetFrameProps {
  widget: Widget;
  data: unknown;
  error: ApiError['error'] | null;
  loading: boolean;
  editing: boolean;
  /**
   * The callbacks take the widget rather than closing over it.
   *
   * With `onRefresh={() => refresh(widget.id)}` the grid would hand every frame a
   * brand new function on each of its own renders, and `memo` below would never
   * skip anything -- which is precisely the memoisation the drag budget depends on
   * (04-SPEC-frontend.md 3).
   */
  onRefresh: (widget: Widget) => void;
  onConfigure: (widget: Widget) => void;
  onRemove: (widget: Widget) => void;
}

export const WidgetFrame = memo(function WidgetFrame({
  widget,
  data,
  error,
  loading,
  editing,
  onRefresh,
  onConfigure,
  onRemove,
}: WidgetFrameProps): ReactNode {
  const t = useT();
  const definition = widgetDefinition(widget.type);

  return (
    <section className="bg-surface border-subtle flex h-full flex-col overflow-hidden rounded-lg border">
      <header
        className={[
          'border-subtle flex shrink-0 items-center gap-1 border-b px-3 py-1.5',
          // The whole header is the drag handle in edit mode; outside it, nothing
          // drags at all.
          editing ? 'widget-drag-handle cursor-move' : '',
        ].join(' ')}
      >
        <h3 className="text-primary mr-auto truncate text-sm font-medium">{widget.title}</h3>

        {editing ? (
          <>
            <button
              type="button"
              onClick={() => onConfigure(widget)}
              className="widget-no-drag text-secondary hover:bg-hovered rounded px-1.5 py-0.5 text-xs"
            >
              {t('dashboard.widget.configure')}
            </button>
            <button
              type="button"
              onClick={() => onRemove(widget)}
              className="widget-no-drag text-negative hover:bg-hovered rounded px-1.5 py-0.5 text-xs"
            >
              {t('common.delete')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onRefresh(widget)}
            aria-label={t('dashboard.widget.refresh')}
            title={t('dashboard.widget.refresh')}
            className="text-muted hover:bg-hovered hover:text-secondary rounded px-1.5 py-0.5 text-xs"
          >
            ↻
          </button>
        )}
      </header>

      {/* Scrolls internally; never grows to fit its content. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {error !== null ? (
          <WidgetError message={error.message} onRetry={() => onRefresh(widget)} t={t} />
        ) : definition === undefined ? (
          <WidgetError
            message={t('dashboard.widget.unknownType', { type: widget.type })}
            onRetry={() => onRefresh(widget)}
            t={t}
          />
        ) : loading && data === undefined ? (
          <p className="text-muted text-sm">{t('common.loading')}</p>
        ) : (
          <WidgetErrorBoundary
            fallback={(caught, retry) => (
              <WidgetError message={caught.message} onRetry={retry} t={t} />
            )}
          >
            <definition.Body config={widget.config} data={data} />
          </WidgetErrorBoundary>
        )}
      </div>
    </section>
  );
});
