/**
 * The running version, read from package.json.
 *
 * Adapters put this in their `User-Agent` (`nexuscentral/<version> (+self-hosted)`),
 * so it must not drift from what is published.
 *
 * The relative path resolves identically from `src/` under tsx and from `dist/`
 * after a build -- both are one directory below the package root.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const VERSION = pkg.version ?? '0.0.0';
export const USER_AGENT = `nexuscentral/${VERSION} (+self-hosted)`;
