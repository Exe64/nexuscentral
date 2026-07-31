/**
 * The `custom_api` widget (04-SPEC-frontend.md 4.2).
 *
 * Four generic renderers and no per-widget HTML. That is the whole design: a
 * ported Glance widget contributes a URL and a set of JSON paths, never markup.
 * Interpreting Go templates in JavaScript would be an unbounded task, and copying
 * their HTML would raise a derivative-work question that porting facts does not
 * (04-SPEC-frontend.md 7).
 */

import { memo, useState, type ReactNode } from 'react';
import {
  CUSTOM_API_RENDERS,
  type CustomApiRender,
  type CustomApiWidgetConfig,
  type CustomApiWidgetData,
  type GenericItem,
} from '@nexuscentral/shared';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, formatNumber, relativeTime } from '../lib/format.ts';
import type { WidgetBodyProps, WidgetConfigFormProps } from './registry.tsx';

/** A title, linked when the mapping produced a URL. */
function Title({ item }: { item: GenericItem }): ReactNode {
  if (item.url === undefined) {
    return <span className="text-primary text-sm leading-snug">{item.title}</span>;
  }
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary hover:text-accent block text-sm leading-snug"
    >
      {item.title}
    </a>
  );
}

function When({ item }: { item: GenericItem }): ReactNode {
  if (item.timestamp === undefined) return null;
  return (
    <time dateTime={item.timestamp} title={absoluteTime(item.timestamp)}>
      {relativeTime(item.timestamp)}
    </time>
  );
}

/** Titles only. The densest useful shape, and the right default. */
function ListRender({ items }: { items: GenericItem[] }): ReactNode {
  return (
    <ul className="divide-subtle divide-y">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="py-1">
          <Title item={item} />
        </li>
      ))}
    </ul>
  );
}

/** Titles with the subtitle and time underneath, like the feed widget. */
function ListWithMetaRender({ items }: { items: GenericItem[] }): ReactNode {
  return (
    <ul className="divide-subtle divide-y">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="py-1.5">
          <Title item={item} />
          <p className="text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
            {item.subtitle !== undefined && <span>{item.subtitle}</span>}
            <When item={item} />
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * One big number. Uses the first item, because that is what "single" means;
 * anything past it is ignored rather than silently averaged.
 */
function SingleValueRender({ items, t }: { items: GenericItem[]; t: Translate }): ReactNode {
  const item = items[0];
  if (item === undefined)
    return <p className="text-secondary text-sm">{t('widget.custom_api.empty')}</p>;

  const value = item.value ?? item.subtitle ?? '—';

  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-primary text-3xl font-semibold tabular-nums">
        {typeof value === 'number' ? formatNumber(value) : value}
      </p>
      <p className="text-secondary mt-1 text-sm">{item.title}</p>
      <p className="text-muted mt-0.5 text-xs">
        <When item={item} />
      </p>
    </div>
  );
}

/** A definition list: the title on the left, the value on the right. */
function KeyValuesRender({ items }: { items: GenericItem[] }): ReactNode {
  return (
    <dl className="divide-subtle grid grid-cols-[1fr_auto] gap-x-3 divide-y text-sm">
      {items.map((item, index) => (
        <div key={`${item.title}-${index}`} className="col-span-2 grid grid-cols-subgrid py-1">
          <dt className="text-secondary truncate">{item.title}</dt>
          <dd className="text-primary tabular-nums">
            {typeof item.value === 'number'
              ? formatNumber(item.value)
              : (item.value ?? item.subtitle ?? '—')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const RENDERERS: Record<
  CustomApiRender,
  (props: { items: GenericItem[]; t: Translate }) => ReactNode
> = {
  list: ({ items }) => <ListRender items={items} />,
  list_with_meta: ({ items }) => <ListWithMetaRender items={items} />,
  single_value: SingleValueRender,
  key_values: ({ items }) => <KeyValuesRender items={items} />,
};

export const CustomApiWidget = memo(function CustomApiWidget({
  config,
  data,
}: WidgetBodyProps): ReactNode {
  const t = useT();
  const typed = config as unknown as CustomApiWidgetConfig;
  const payload = data as CustomApiWidgetData | undefined;
  const [expanded, setExpanded] = useState(false);

  if (payload === undefined) return null;

  if (payload.items.length === 0) {
    return <p className="text-secondary text-sm">{t('widget.custom_api.empty')}</p>;
  }

  const render = payload.render ?? typed.render;

  // `single_value` shows one thing by definition, so collapsing makes no sense.
  const limit = render === 'single_value' ? null : typed.collapseAfter;
  const collapsed = limit !== null && !expanded && payload.items.length > limit;
  const visible = collapsed ? payload.items.slice(0, limit) : payload.items;

  const Renderer = RENDERERS[render];

  return (
    <>
      <Renderer items={visible} t={t} />

      {collapsed && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-accent mt-2 text-xs hover:underline"
        >
          {t('widget.feed.showMore', { count: payload.items.length - visible.length })}
        </button>
      )}

      {payload.total > payload.items.length && (
        <p className="text-muted mt-2 text-xs">
          {t('widget.feed.showing', {
            shown: formatNumber(payload.items.length),
            total: formatNumber(payload.total),
          })}
        </p>
      )}
    </>
  );
});

export function CustomApiConfigForm({ value, onChange }: WidgetConfigFormProps): ReactNode {
  const t = useT();
  const config = value as unknown as CustomApiWidgetConfig;

  const set = (patch: Partial<CustomApiWidgetConfig>): void =>
    onChange({ ...value, ...patch } as Record<string, unknown>);

  /** Params, headers and fields are all `Record<string, string>` edited as text. */
  const asLines = (record: Record<string, string>): string =>
    Object.entries(record)
      .map(([key, entry]) => `${key}: ${entry}`)
      .join('\n');

  const fromLines = (text: string): Record<string, string> => {
    const record: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const at = line.indexOf(':');
      if (at === -1) continue;
      const key = line.slice(0, at).trim();
      if (key !== '') record[key] = line.slice(at + 1).trim();
    }
    return record;
  };

  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.url')}</span>
        <input
          type="url"
          value={config.url}
          placeholder="https://api.github.com/repos/owner/repo/releases"
          onChange={(event) => set({ url: event.target.value })}
          className="mt-1 block w-full"
        />
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.params')}</span>
        <textarea
          rows={2}
          value={asLines(config.params)}
          placeholder="per_page: 5"
          onChange={(event) => set({ params: fromLines(event.target.value) })}
          className="mt-1 block w-full font-mono text-xs"
        />
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.headers')}</span>
        <textarea
          rows={2}
          value={asLines(config.headers)}
          placeholder="Authorization: Bearer ${GITHUB_TOKEN}"
          onChange={(event) => set({ headers: fromLines(event.target.value) })}
          className="mt-1 block w-full font-mono text-xs"
        />
        <span className="text-muted mt-0.5 block text-xs">
          {t('widget.custom_api.headers.hint')}
        </span>
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.root')}</span>
        <input
          value={config.mapping.root}
          placeholder="$"
          onChange={(event) => set({ mapping: { ...config.mapping, root: event.target.value } })}
          className="mt-1 block w-full font-mono text-xs"
        />
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.fields')}</span>
        <textarea
          rows={4}
          value={asLines(config.mapping.fields)}
          placeholder={
            'title: $.name\nurl: $.html_url\nsubtitle: $.tag_name\ntimestamp: $.published_at'
          }
          onChange={(event) =>
            set({ mapping: { ...config.mapping, fields: fromLines(event.target.value) } })
          }
          className="mt-1 block w-full font-mono text-xs"
        />
        <span className="text-muted mt-0.5 block text-xs">
          {t('widget.custom_api.fields.hint')}
        </span>
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.render')}</span>
        <select
          value={config.render}
          onChange={(event) => set({ render: event.target.value as CustomApiRender })}
          className="ml-2"
        >
          {CUSTOM_API_RENDERS.map((option) => (
            <option key={option} value={option}>
              {t(`widget.custom_api.render.${option}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.custom_api.ttl')}</span>
        <input
          type="number"
          min={1}
          max={1440}
          value={config.ttlMinutes}
          onChange={(event) => set({ ttlMinutes: Number(event.target.value) })}
          className="ml-2 w-20"
        />
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.feed.collapseAfter')}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={config.collapseAfter ?? ''}
          placeholder={t('widget.feed.collapseAfter.off')}
          onChange={(event) =>
            set({ collapseAfter: event.target.value === '' ? null : Number(event.target.value) })
          }
          className="ml-2 w-20"
        />
      </label>
    </div>
  );
}
