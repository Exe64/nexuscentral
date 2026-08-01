/**
 * Environment configuration, validated once at import time.
 *
 * A missing or malformed variable must fail the process at startup, not at the
 * first request that happens to need it.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Never let a stray .env override a real deployment environment.
loadDotenv({ override: false, quiet: true });

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  BIND_ADDR: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Number of reverse proxies in front of the API. Unset means "no proxy". */
  TRUST_PROXY: z.coerce.number().int().min(0).optional(),

  /**
   * Bootstrap password, read once on the first boot that finds no credential.
   *
   * Not validated for length here: `passwordProblem` owns that rule, and failing
   * environment parsing would take the whole process down with a message that
   * looks like a configuration error rather than a weak password.
   */
  AUTH_PASSWORD: z.string().optional(),

  WORKER_ENABLED: booleanish.default('true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default('false'),

  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z
    .string()
    .min(1)
    .default('nexuscentral/1.0 (self-hosted personal aggregator)'),

  NITTER_BASE_URLS: csv.default(''),

  ALLOW_PRIVATE_TARGETS: booleanish.default('false'),

  /**
   * The commit this build was deployed from, set by deploy.sh.
   *
   * Optional because a dev run has none, and the update check reports "unknown"
   * rather than guessing. Short or full: deploy.sh passes `rev-parse --short`
   * and GitHub answers with 40 characters, so the comparison is by prefix.
   */
  GIT_SHA: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'GIT_SHA must be a hex commit sha')
    .optional(),

  /**
   * Constrained to `owner/repo` because it is interpolated into a GitHub API
   * path. Unvalidated, `UPDATE_REPO=x/y/../../users/z` would reach a different
   * endpoint entirely -- operator-supplied rather than user-supplied, but one
   * regex is cheaper than reasoning about who can set it.
   */
  UPDATE_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'UPDATE_REPO must look like owner/repo')
    .default('Exe64/nexuscentral'),

  /** An off switch for the one outbound call the app makes on its own behalf. */
  UPDATE_CHECK_ENABLED: booleanish.default('true'),

  /**
   * Where the app leaves an update request for the host agent to find.
   *
   * Optional, and in-app updating is off when it is unset -- which is the right
   * default: it only works if the systemd timer in deploy/ is installed, and a
   * button that silently does nothing is worse than no button.
   */
  UPDATE_CONTROL_DIR: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Treat empty strings as absent: `FOO=` in a .env file is how a variable gets
  // documented-but-unset, and zod would otherwise reject it as a bad value.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return result.data;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Exposed for tests, which need to validate arbitrary environments. */
export { parseEnv, schema as envSchema };
