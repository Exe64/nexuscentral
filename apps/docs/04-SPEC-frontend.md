# 04 — SPEC: Frontend

React 19 + Vite + TypeScript. Tailwind CSS v4. `react-grid-layout`.
State: TanStack Query for server state, `zustand` for UI state (theme, edit mode, sidebar).
No Redux.

---

## 1. Routes

```
/                    redirect to the first dashboard
/d/:dashboardId      dashboard grid
/reader              full-height item list with filters (the "read everything" view)
/sources             source management
/tags                tag management
/rules               rule editor with live test
/alerts              alert history
/settings            appearance, integrations, retention
```

The dashboard is the home surface; `/reader` exists for deliberate catch-up sessions where
a grid gets in the way.

## 2. Layout shell

- Persistent left sidebar on `lg+`: navigation, dashboard switcher, tag list with unread
  counts. Collapses to a bottom bar on mobile.
- Top bar: current view title, search, refresh, edit-mode toggle, theme toggle.
- Keyboard shortcuts: `j`/`k` next/previous item, `o` open, `m` toggle read, `s` star,
  `r` refresh, `/` focus search, `?` shortcut overlay. These are what make daily reading
  fast — implement them, do not defer.

## 3. The grid

`ResponsiveGridLayout` with `WidthProvider`.

```ts
const breakpoints = { lg: 1200, md: 996, sm: 768, xs: 480 };
const cols = { lg: 12, md: 10, sm: 6, xs: 2 };
const rowHeight = 40;
const margin = [16, 16];
```

Rules:

- **Edit mode is explicit.** `isDraggable` and `isResizable` are `false` until the user
  toggles edit mode. Accidental drags while reading are the fastest way to make a dashboard
  feel broken.
- On `xs`, force a single column, disable dragging entirely, and order widgets by their `lg`
  position (top-to-bottom, left-to-right). Nobody resizes widgets with a thumb on a train.
- `onLayoutChange` fires constantly during a drag. Debounce persistence at 1000 ms and only
  `PATCH` when the layout actually differs from what was loaded.
- Each widget declares `minW` / `minH` in its type definition (§4). Enforce them so a widget
  cannot be shrunk into unreadability.
- Widgets scroll internally (`overflow-y: auto` on the body), never resize to fit content.
  A fixed grid cell with an internal scrollbar is what makes the layout stable.
- Use `useMemo` for the layout objects and `React.memo` on widget bodies. Without this,
  dragging one widget re-renders all of them and the drag stutters at ~15 widgets.

Add-widget flow: edit mode → "Add widget" → type picker → config form → the widget is
appended at the bottom of the grid at its default size.

## 4. Widget types

Every widget implements:

```ts
interface WidgetDefinition<C> {
  type: WidgetType;
  label: string; // English, sentence case
  description: string;
  configSchema: ZodSchema<C>;
  defaultConfig: C;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  ConfigForm: React.FC<{ value: C; onChange: (c: C) => void }>;
  Body: React.FC<{ config: C; data: unknown }>;
}
```

Register them in a map keyed by type. Adding a widget type must require touching exactly
one new file plus one registry line.

### 4.1 `feed`

The core widget. This is what makes the tag system pay off.

```ts
{
  tagIds: number[];          // empty = all sources
  sourceIds: number[];
  sort: 'score' | 'published' | 'engagement';
  unreadOnly: boolean;
  minScore: number | null;
  limit: number;             // 1..50, default 15
  showThumbnails: boolean;
  showSource: boolean;
  collapseAfter: number | null;  // borrowed from Glance — see note
  density: 'comfortable' | 'compact';
}
```

`collapseAfter` renders N items and hides the rest behind a "Show more" control. This is
the single best idea in Glance's design: it stops one chatty source from burying every
other widget on the page. Implement it.

Each row shows: title (visited-state styling), source name + icon, relative time,
engagement when present, and the score as a subtle badge. Clicking the score badge opens
the breakdown popover from `GET /api/items/:id` — that is how a rule set gets debugged.

### 4.2 `custom_api`

Config is the fetch spec from `03-SPEC-api.md` §7 plus a `render` choice:

```ts
{
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  mapping: {
    root: string;
    fields: Record<string, string>;
  }
  render: 'list' | 'list_with_meta' | 'single_value' | 'key_values';
  ttlMinutes: number;
  collapseAfter: number | null;
}
```

Four generic renderers, no per-widget HTML. See §7 for why.

### 4.3 `alerts`

Unacknowledged alerts, newest first, with the matched rule name and an ack button.

### 4.4 `source_health`

Sources with `consecutive_failures > 0` or `consecutive_empty >= 3`, with last error and a
"Poll now" button. Empty state: "All sources healthy." — that is a feature, not a blank box.

### 4.5 `stats`

Items ingested today / this week, unread count, top 5 sources by volume, and the Reddit
budget gauge.

## 5. Theming

Three requirements: light theme, dark theme, and a user-selectable accent colour.

### 5.1 Mode

`settings.theme_mode` is `light | dark | system`. Applied as `data-theme="light|dark"` on
`<html>` — always a concrete value, never `system`, so CSS never branches on media queries.

In `system` mode, subscribe to `matchMedia('(prefers-color-scheme: dark)')` and update the
attribute on change.

**No-flash guard.** Inline this in `index.html` before any stylesheet:

```html
<script>
  (function () {
    var s = JSON.parse(localStorage.getItem('feedhub.theme') || '{}');
    var mode = s.mode || 'system';
    var dark =
      mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    var d = document.documentElement;
    d.dataset.theme = dark ? 'dark' : 'light';
    if (s.hue != null) d.style.setProperty('--accent-h', s.hue);
    if (s.chroma != null) d.style.setProperty('--accent-c', s.chroma);
  })();
</script>
```

`localStorage` is the render-time cache; PostgreSQL is the source of truth. On app boot,
fetch settings and reconcile — the server value wins.

### 5.2 Accent

Store **hue** (0–360) and **chroma** (0–0.37), not a hex value. The whole accent ramp is
derived in OKLCH from those two numbers, which keeps perceptual lightness constant across
hues — a yellow accent and a blue accent end up equally readable, which is not true of an
HSL ramp.

```css
:root {
  --accent-h: 250;
  --accent-c: 0.14;

  --accent-50: oklch(0.97 calc(var(--accent-c) * 0.2) var(--accent-h));
  --accent-100: oklch(0.93 calc(var(--accent-c) * 0.35) var(--accent-h));
  --accent-200: oklch(0.87 calc(var(--accent-c) * 0.55) var(--accent-h));
  --accent-300: oklch(0.79 calc(var(--accent-c) * 0.75) var(--accent-h));
  --accent-400: oklch(0.7 calc(var(--accent-c) * 0.9) var(--accent-h));
  --accent-500: oklch(0.62 var(--accent-c) var(--accent-h));
  --accent-600: oklch(0.54 var(--accent-c) var(--accent-h));
  --accent-700: oklch(0.46 calc(var(--accent-c) * 0.9) var(--accent-h));
  --accent-800: oklch(0.38 calc(var(--accent-c) * 0.75) var(--accent-h));
  --accent-900: oklch(0.3 calc(var(--accent-c) * 0.55) var(--accent-h));
}
```

### 5.3 Semantic tokens

Components reference **only** semantic tokens. No component may use `--accent-500` or a raw
colour directly.

```css
[data-theme='light'] {
  --bg-base: oklch(0.99 0.002 var(--accent-h));
  --bg-surface: oklch(1 0 0);
  --bg-raised: oklch(0.97 0.003 var(--accent-h));
  --bg-hover: oklch(0.95 0.005 var(--accent-h));
  --border-subtle: oklch(0.91 0.004 var(--accent-h));
  --border-strong: oklch(0.82 0.006 var(--accent-h));
  --text-primary: oklch(0.24 0.008 var(--accent-h));
  --text-secondary: oklch(0.48 0.008 var(--accent-h));
  --text-muted: oklch(0.62 0.006 var(--accent-h));
  --text-visited: oklch(0.6 0.01 var(--accent-h));
  --accent: var(--accent-600);
  --accent-hover: var(--accent-700);
  --accent-fg: oklch(1 0 0);
  --accent-subtle: var(--accent-50);
}

[data-theme='dark'] {
  --bg-base: oklch(0.17 0.006 var(--accent-h));
  --bg-surface: oklch(0.21 0.008 var(--accent-h));
  --bg-raised: oklch(0.25 0.01 var(--accent-h));
  --bg-hover: oklch(0.29 0.012 var(--accent-h));
  --border-subtle: oklch(0.31 0.01 var(--accent-h));
  --border-strong: oklch(0.42 0.012 var(--accent-h));
  --text-primary: oklch(0.94 0.004 var(--accent-h));
  --text-secondary: oklch(0.74 0.006 var(--accent-h));
  --text-muted: oklch(0.58 0.006 var(--accent-h));
  --text-visited: oklch(0.62 0.01 var(--accent-h));
  --accent: var(--accent-400);
  --accent-hover: var(--accent-300);
  --accent-fg: oklch(0.18 0.01 var(--accent-h));
  --accent-subtle: var(--accent-900);
}
```

Note the tiny chroma on neutrals, tied to `--accent-h`: backgrounds pick up a trace of the
accent hue. It costs nothing and is why the accent picker feels like it changes the app
rather than just recolouring the buttons.

Status colours (`--positive`, `--negative`, `--warning`) are **fixed hues**, not derived
from the accent. An error must stay red when the accent is red.

Tag colours map to fixed hues in the same OKLCH scale, with per-theme lightness. A tag must
stay legible in both themes.

### 5.4 Settings UI

- Mode: three-way segmented control (Light / Dark / System)
- Accent: hue slider (0–360) rendered as a live OKLCH gradient, plus 8 preset swatches
- Chroma: a two-step control labelled "Muted / Vivid" (0.06 / 0.14), not a raw number
- Live preview applied immediately to the whole app, persisted on release

### 5.5 Non-negotiables

- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI borders, **in both themes at
  every accent hue**. Add a unit test that samples 12 hues and asserts the computed
  contrast of `--text-primary` on `--bg-base` and `--accent-fg` on `--accent`.
- Visible keyboard focus everywhere: `outline: 2px solid var(--accent); outline-offset: 2px`.
- Respect `prefers-reduced-motion`: disable grid drag animations and transitions.
- Never transition `background-color` on theme switch — a 300 ms crossfade across the whole
  page reads as sluggish.

## 6. Internationalisation

The UI ships in **English only**, but no string is hardcoded in a component.

- All copy lives in `/apps/web/src/locales/en.json`, flat namespaced keys
  (`sources.add.title`, `widgets.feed.empty`).
- A thin `t(key, params?)` helper reading from a context. **No i18n library** — the
  dependency is not justified for one locale.
- Dates and numbers via `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` with an explicit
  `en` locale, never string concatenation.
- Adding a second locale later must mean adding a JSON file and a picker, nothing else.

**Copy rules.** Sentence case, active voice, no filler. A button states what happens
("Add source", not "Submit"); the confirmation uses the same verb ("Source added"). Errors
say what went wrong and what to do, and never apologise. Empty states are invitations:
"No sources yet. Add a feed, subreddit or X account to get started." — with the action
inline.

## 7. Porting Glance community widgets

Glance community widgets are `type: custom-api` YAML with a Go `text/template` body using
Glance-specific helpers (`.JSON.Array`, `.String`, `sortByTime`, `parseRelativeTime`) and
Glance CSS classes (`list-gap-14`, `collapsible-container`, `data-collapse-after`).

**Do not attempt to interpret Go templates in JavaScript.** That is an unbounded task for
no benefit.

Read the YAML as a **fetch specification**, not a rendering one. The portable part is
`url` + `params` + `headers` + the JSON paths used inside the template. That maps directly
onto the `custom_api` config in §4.2 and takes about ten minutes per widget by hand.

Deliver a small CLI helper, `pnpm port-widget <path-to-readme.md>`, that extracts the YAML
block, pulls out url/params/headers, lists the `.String "field"` / `.Int "field"` accessors
it finds, and prints a draft `custom_api` config for manual completion. Best-effort — it
assists the port, it does not automate it.

Ignore Glance _extension_ widgets entirely: they require running a separate server or
container.

**Licensing:** Glance is AGPL-3.0. Copying template HTML raises a derivative-work question.
Porting the fetch spec (a URL and a set of field names — facts, not expression) does not.
Since only the fetch spec is reused, no attribution obligation is triggered; keep it that
way and do not copy template markup.

## 8. Empty and error states

| Surface                            | Empty state                                                          |
| ---------------------------------- | -------------------------------------------------------------------- |
| Dashboard, no widgets              | "This dashboard is empty." + "Add widget"                            |
| Feed widget, no items              | "No items match this filter." + "Edit filter"                        |
| Feed widget, unread only, all read | "All caught up."                                                     |
| Sources page                       | "No sources yet. Add a feed, subreddit or X account to get started." |
| Rules page                         | "No rules yet. Rules boost or bury items by keyword." + "Add rule"   |
| Alerts                             | "No alerts. Turn on alerting in a rule to get notified here."        |

Widget-level errors render inside the widget with the message and a retry button. One
broken widget must never blank the dashboard — wrap each in an error boundary.
