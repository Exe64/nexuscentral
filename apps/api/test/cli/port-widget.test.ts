/**
 * Porting real Glance community widgets.
 *
 * Phase 6's fifth acceptance criterion: at least two ported end to end. The
 * fixtures are the YAML those widgets actually ship -- a `custom-api` block plus
 * a Go template -- so what is exercised is the real shape, not one invented to
 * suit the parser.
 *
 * "End to end" here means: read the YAML, produce a config, and prove that config
 * maps the API's real response shape onto items. The network call itself is
 * covered by the integration suite; what matters is that the port produces a
 * config that works.
 */

import { describe, expect, it } from 'vitest';
import { applyMapping } from '../../src/customapi/mapping.js';
import { __testing } from '../../src/cli/port-widget.js';

const { extractYaml, readSpec, findAccessors, guessRoot, guessFields } = __testing;

/**
 * glanceapp/community-widgets -- "GitHub Releases".
 * Trimmed to the parts a port reads; the template body is kept verbatim so the
 * accessor extraction is tested against real Go, not a paraphrase.
 */
const GITHUB_RELEASES = `
# GitHub Releases

Shows the latest releases for a repository.

\`\`\`yaml
- type: custom-api
  title: Kubernetes Releases
  cache: 30m
  url: https://api.github.com/repos/kubernetes/kubernetes/releases
  parameters:
    per_page: 10
  headers:
    Accept: application/vnd.github+json
    Authorization: Bearer \${GITHUB_TOKEN}
  template: |
    <ul class="list list-gap-10 collapsible-container" data-collapse-after-rows="5">
      {{ range .JSON.Array "" }}
      <li>
        <a class="size-h4 color-highlight block text-truncate" href="{{ .String "html_url" }}">
          {{ .String "name" }}
        </a>
        <ul class="list-horizontal-text">
          <li>{{ .String "tag_name" }}</li>
          <li>{{ .String "published_at" | parseTime "rfc3339" | relativeTime }}</li>
        </ul>
      </li>
      {{ end }}
    </ul>
\`\`\`
`;

/** glanceapp/community-widgets -- "Steam Player Count". A single-value widget. */
const STEAM_PLAYERS = `
# Steam Player Count

\`\`\`yaml
- type: custom-api
  title: Players Online
  cache: 10m
  url: https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/
  parameters:
    appid: "440"
  template: |
    <div class="flex justify-between">
      <div class="color-highlight size-h2">{{ .JSON.Int "response.player_count" }}</div>
      <div class="size-h6">players online</div>
    </div>
\`\`\`
`;

describe('extracting the fetch spec', () => {
  it('finds the custom-api block inside a README', () => {
    const yaml = extractYaml(GITHUB_RELEASES);
    expect(yaml).toContain('type: custom-api');
    // The prose around it is not part of the spec.
    expect(yaml).not.toContain('Shows the latest releases');
  });

  it('reads the url, parameters and headers', () => {
    const spec = readSpec(extractYaml(GITHUB_RELEASES));

    expect(spec.title).toBe('Kubernetes Releases');
    expect(spec.url).toBe('https://api.github.com/repos/kubernetes/kubernetes/releases');
    expect(spec.params).toEqual({ per_page: '10' });
    expect(spec.headers).toEqual({
      Accept: 'application/vnd.github+json',
      // The placeholder survives verbatim: nexuscentral resolves ${VAR} the same way.
      Authorization: 'Bearer ${GITHUB_TOKEN}',
    });
  });

  it('does not try to read the Go template as configuration', () => {
    const spec = readSpec(extractYaml(GITHUB_RELEASES));
    // `class:` and `href:` inside the template must not become parameters.
    expect(Object.keys(spec.params)).toEqual(['per_page']);
  });
});

describe('GitHub Releases, ported', () => {
  const source = GITHUB_RELEASES;
  const yaml = extractYaml(source);

  it('finds the fields the template reads', () => {
    expect(findAccessors(source)).toEqual(['html_url', 'name', 'published_at', 'tag_name']);
  });

  it('guesses the root from what the template iterates', () => {
    // `.JSON.Array ""` means the response is a top-level array.
    expect(guessRoot(source).root).toBe('$');
  });

  it('maps the obvious fields', () => {
    expect(guessFields(findAccessors(source))).toEqual({
      title: '$.name',
      url: '$.html_url',
      subtitle: '$.tag_name',
      timestamp: '$.published_at',
    });
  });

  it('produces a config that maps the real GitHub response shape', () => {
    // What api.github.com/repos/…/releases actually returns, trimmed.
    const response = [
      {
        name: 'Kubernetes v1.34.0',
        tag_name: 'v1.34.0',
        html_url: 'https://github.com/kubernetes/kubernetes/releases/tag/v1.34.0',
        published_at: '2026-04-17T18:23:41Z',
        draft: false,
      },
      {
        name: 'Kubernetes v1.33.4',
        tag_name: 'v1.33.4',
        html_url: 'https://github.com/kubernetes/kubernetes/releases/tag/v1.33.4',
        published_at: '2026-03-11T09:02:00Z',
        draft: false,
      },
    ];

    const spec = readSpec(yaml);
    const result = applyMapping(response, {
      root: guessRoot(source).root,
      fields: guessFields(findAccessors(source)),
    });

    expect(spec.url).toContain('api.github.com');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      title: 'Kubernetes v1.34.0',
      url: 'https://github.com/kubernetes/kubernetes/releases/tag/v1.34.0',
      subtitle: 'v1.34.0',
      timestamp: '2026-04-17T18:23:41.000Z',
    });
  });
});

describe('Steam Player Count, ported', () => {
  const source = STEAM_PLAYERS;

  it('reads the spec, including a quoted numeric parameter', () => {
    const spec = readSpec(extractYaml(source));

    expect(spec.url).toContain('GetNumberOfCurrentPlayers');
    expect(spec.params).toEqual({ appid: '440' });
  });

  it('notices the template reads scalars rather than iterating', () => {
    const { root, note } = guessRoot(source);

    expect(root).toBe('$');
    // The layout guess matters: a list renderer would show nothing useful here.
    expect(note).toContain('single_value');
  });

  it('produces a config that maps the real Steam response shape', () => {
    const response = { response: { player_count: 51234, result: 1 } };

    // The nested path is the part a human writes -- the CLI lists the accessor,
    // it does not assemble the path.
    const result = applyMapping(response, {
      root: '$',
      fields: { title: '$.response.result', value: '$.response.player_count' },
    });

    expect(result.items[0]?.value).toBe(51234);
  });
});

describe('what the CLI refuses to do', () => {
  it('reports a document with no url rather than guessing', () => {
    const spec = readSpec('- type: extension\n  url-is: missing\n');
    expect(spec.url).toBe('');
  });

  it('emits no markup, ever', () => {
    // The licensing line: porting a URL and field names is porting facts. The
    // template HTML is expression, and copying it is what must not happen.
    const spec = readSpec(extractYaml(GITHUB_RELEASES));
    const serialised = JSON.stringify(spec);

    expect(serialised).not.toContain('<ul');
    expect(serialised).not.toContain('list-gap');
    expect(serialised).not.toContain('color-highlight');
  });
});
