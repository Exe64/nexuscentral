/* eslint-disable */
/**
 * Authentication.
 *
 * This reverses 00-CONTEXT.md 5, which said the app would carry no login and sit
 * behind the reverse proxy's basic auth. Basic auth has no logout, no session to
 * revoke, and re-sends the credential on every request; the application now
 * authenticates for itself.
 *
 * Single user throughout: one credential row, enforced by the primary key.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Exactly one row, ever: a boolean primary key with CHECK (id) admits only
    -- the value true, so a second credential cannot be inserted even by accident.
    CREATE TABLE auth_credential (
      id            boolean PRIMARY KEY DEFAULT true CHECK (id),
      -- scrypt, self-describing: "scrypt$N$r$p$salt$hash". Storing the parameters
      -- beside the hash is what makes raising the cost later a non-event.
      password_hash text        NOT NULL,
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    -- Sessions. The token itself is never stored: only its SHA-256, so a database
    -- leak yields nothing that can be replayed as a cookie.
    CREATE TABLE sessions (
      id           bigserial   PRIMARY KEY,
      token_hash   bytea       NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      user_agent   text,
      ip           inet,

      CONSTRAINT sessions_token_unique UNIQUE (token_hash)
    );

    -- Sweeping expired sessions is a range scan over this.
    CREATE INDEX sessions_expires_idx ON sessions (expires_at);

    -- Login attempts, for rate limiting and for an audit trail.
    --
    -- In the database rather than in memory: an in-memory counter resets on every
    -- restart, and a lockout that a crash clears is not a lockout. The volume is
    -- trivial for one user.
    CREATE TABLE auth_attempts (
      id         bigserial   PRIMARY KEY,
      ip         inet,
      at         timestamptz NOT NULL DEFAULT now(),
      successful boolean     NOT NULL
    );

    CREATE INDEX auth_attempts_recent_idx ON auth_attempts (at DESC);
    CREATE INDEX auth_attempts_ip_idx ON auth_attempts (ip, at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS auth_attempts;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS auth_credential;
  `);
};
