/**
 * `pnpm port-widget <path-or-url>` (04-SPEC-frontend.md 7).
 *
 * Glance community widgets are `type: custom-api` YAML with a Go `text/template`
 * body. The template is not portable and interpreting Go templates in JavaScript
 * is an unbounded task for no benefit. The *fetch specification* is portable: a
 * URL, some parameters, some headers, and the JSON paths the template reads.
 *
 * So this reads the YAML as a fetch spec, never as a rendering one. It extracts
 * url/params/headers, lists the `.String "field"` accessors it finds, and prints
 * a draft config to finish by hand. Best effort, and it says so: it assists the
 * port, it does not automate it.
 *
 * **Licensing.** Glance is AGPL-3.0. Copying template HTML would raise a
 * derivative-work question; a URL and a set of field names are facts, not
 * expression. Only the fetch spec is read, and no markup is ever emitted --
 * deliberately, and worth keeping that way.
 */

import { readFile } from 'node:fs/promises';

interface Draft {
  title: string;
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  accessors: string[];
  notes: string[];
}

/** Pull the first fenced YAML block, or treat the whole file as YAML. */
function extractYaml(source: string): string {
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  for (const match of source.matchAll(fenced)) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }

  // The one that looks like a widget, not the example output above it.
  const widget = blocks.find((block) => /type:\s*custom-api/.test(block));
  if (widget !== undefined) return widget;
  if (blocks.length > 0) return blocks[0] as string;
  return source;
}

/**
 * A deliberately small YAML reader.
 *
 * Only what a Glance custom-api block uses: top-level scalars, and two levels of
 * `key: value` maps under `parameters:` and `headers:`. Pulling in a YAML parser
 * for this would be more dependency than the job is worth, and a real parser
 * would still not understand the Go template that follows.
 */
function readSpec(yaml: string): Draft {
  const draft: Draft = { title: '', url: '', params: {}, headers: {}, accessors: [], notes: [] };

  const lines = yaml.split('\n');
  let section: 'params' | 'headers' | null = null;
  let sectionIndent = 0;

  const unquote = (value: string): string =>
    value
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (section !== null && indent <= sectionIndent) section = null;

    const pair = /^-?\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair === null) continue;

    const key = (pair[1] ?? '').toLowerCase();
    const value = pair[2] ?? '';

    if (section !== null) {
      const target = section === 'params' ? draft.params : draft.headers;
      if (value !== '') target[pair[1] as string] = unquote(value);
      continue;
    }

    switch (key) {
      case 'title':
        draft.title = unquote(value);
        break;
      case 'url':
        draft.url = unquote(value);
        break;
      case 'parameters':
        section = 'params';
        sectionIndent = indent;
        break;
      case 'headers':
        section = 'headers';
        sectionIndent = indent;
        break;
      case 'template':
        // Everything after this is Go, and none of it is portable.
        break;
      default:
        break;
    }
  }

  return draft;
}

/**
 * Field accessors used by the template.
 *
 * `.String "name"`, `.Int "count"`, `.Array "items"` and friends. These name the
 * JSON keys the widget reads, which is exactly what a `fields` mapping needs --
 * the paths still have to be assembled by hand, which is the part this cannot do.
 */
function findAccessors(source: string): string[] {
  const found = new Set<string>();
  const accessor = /\.(?:String|Int|Float|Bool|Array|Object)\s+"([^"]+)"/g;
  for (const match of source.matchAll(accessor)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/** Guess a root path from what the template iterates over. */
function guessRoot(source: string): { root: string; note: string | null } {
  const arrayed = /\.JSON\.Array\s+"([^"]*)"/.exec(source);
  if (arrayed?.[1] !== undefined) {
    const path = arrayed[1];
    return path === '' ? { root: '$', note: null } : { root: `$.${path}`, note: null };
  }

  if (/\.JSON\.(?:String|Int|Float)\s+"/.test(source)) {
    return {
      root: '$',
      note: 'The template reads scalars rather than iterating; single_value or key_values is probably the right layout.',
    };
  }

  return { root: '$', note: 'Could not tell what the template iterates over -- check the root.' };
}

function guessFields(accessors: string[]): Record<string, string> {
  const fields: Record<string, string> = {};

  // Names that map obviously. Everything else is left for the human.
  const guess: Record<string, RegExp> = {
    title: /^(title|name|headline|subject|full_name)$/i,
    url: /^(url|link|html_url|permalink|web_url)$/i,
    subtitle: /^(subtitle|description|summary|tag_name|author|state)$/i,
    timestamp: /^(created_at|published_at|updated_at|date|time|timestamp|pubDate)$/i,
    value: /^(count|value|total|score|stars|stargazers_count|subscribers)$/i,
  };

  for (const [field, pattern] of Object.entries(guess)) {
    const match = accessors.find((accessor) => pattern.test(accessor));
    if (match !== undefined) fields[field] = `$.${match}`;
  }

  return fields;
}

function render(draft: Draft, root: string, fields: Record<string, string>): string {
  const config = {
    url: draft.url,
    params: draft.params,
    headers: draft.headers,
    mapping: { root, fields },
    render: 'list_with_meta',
    ttlMinutes: 30,
    collapseAfter: 5,
  };

  return JSON.stringify(config, null, 2);
}

async function readSource(target: string): Promise<string> {
  if (/^https?:\/\//i.test(target)) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`${target} answered ${response.status}`);
    return response.text();
  }
  return readFile(target, 'utf8');
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write(
      'Usage: pnpm port-widget <path to README.md or yaml, or a URL>\n' +
        '\n' +
        'Reads a Glance custom-api widget as a fetch specification and prints a\n' +
        'draft config. The field mapping is a guess -- check it against the API.\n',
    );
    process.exitCode = 2;
    return;
  }

  const source = await readSource(target);
  const yaml = extractYaml(source);
  const draft = readSpec(yaml);

  if (draft.url === '') {
    process.stderr.write(
      'No `url:` found. Is this a Glance custom-api widget?\n' +
        'Extension widgets are out of scope: they need a separate server.\n',
    );
    process.exitCode = 1;
    return;
  }

  const accessors = findAccessors(source);
  const { root, note } = guessRoot(source);
  const fields = guessFields(accessors);

  const out = (line = ''): void => void process.stdout.write(`${line}\n`);

  out(`# ${draft.title === '' ? 'Ported widget' : draft.title}`);
  out();
  out('Draft config -- paste into a custom_api widget and correct it:');
  out();
  out(render(draft, root, fields));
  out();

  if (accessors.length > 0) {
    out('Fields the template reads:');
    for (const accessor of accessors) {
      const mapped = Object.entries(fields).find(([, path]) => path === `$.${accessor}`);
      out(`  ${accessor}${mapped === undefined ? '' : `   -> ${mapped[0]}`}`);
    }
    out();
  }

  const notes = [...draft.notes];
  if (note !== null) notes.push(note);
  if (Object.keys(fields).length === 0) {
    notes.push('Nothing mapped automatically -- write the fields by hand from the list above.');
  }
  if (Object.keys(draft.headers).some((name) => /auth|token|key/i.test(name))) {
    notes.push('This widget needs a credential. Use ${VAR} and set it in the environment.');
  }

  if (notes.length > 0) {
    out('Notes:');
    for (const item of notes) out(`  - ${item}`);
    out();
  }

  out('Check it with POST /api/custom-api/preview before saving; that reports what');
  out('the root actually selected, which is the only way to tell a wrong path.');
}

/** Exposed so the ported-widget tests exercise the real extraction, not a copy. */
export const __testing = { extractYaml, readSpec, findAccessors, guessRoot, guessFields, render };

// Only when invoked as a script: importing this module must not run it.
if (process.argv[1] !== undefined && /port-widget\.[tj]s$/.test(process.argv[1])) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
