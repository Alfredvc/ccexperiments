# Widgets Service

Fixture CLAUDE.md used by the claude-code-caching test harness. Content is
intentionally plausible-but-fake so it mirrors the shape of a real project
CLAUDE.md (token volume, section structure, directives) without coupling
the harness to any real codebase.

## Purpose

Widgets Service is a backend for creating, updating, and exchanging
widgets between authenticated users. It fronts a Postgres store via a
thin REST layer and emits events to an internal message bus. The service
is the system of record for widget ownership, transfer history, and
aggregate inventory statistics surfaced on the dashboard.

## Architecture

- `cmd/widgetd/` — service entrypoint, wires config, logger, HTTP server
- `internal/api/` — REST handlers, middleware (auth, rate limiting, request logging)
- `internal/store/` — Postgres repository layer; migrations under `internal/store/migrations/`
- `internal/events/` — outbound event publication via the `bus` package
- `internal/domain/` — pure domain types and invariants (no I/O)
- `pkg/client/` — generated HTTP client used by downstream services

All external I/O goes through interfaces defined in `internal/domain`;
tests substitute fakes rather than mocks to keep integration realistic.

## Conventions

### Go style
- Errors wrapped with `%w` and a short, lowercase, no-period message
- No `interface{}` in exported signatures; prefer typed generics or a named interface
- Tests use table-driven subtests with descriptive names matching the
  production function under test
- No global state except the logger; anything else passes through the
  `App` struct constructed in `cmd/widgetd/main.go`

### Database
- Migrations are forward-only; rollbacks are explicit new migrations
- Every table has `created_at` and `updated_at` timestamptz columns, UTC
- Foreign keys use `ON DELETE RESTRICT`; deletes happen at the domain
  layer so business rules fire

### HTTP
- All handlers return JSON; errors use RFC 7807 problem details
- Authentication via `Authorization: Bearer <jwt>`; validated by
  `internal/api/middleware.Auth`
- Request IDs propagate from the `X-Request-ID` header and are logged at
  every layer

## Development Workflow

1. `make tidy` — go mod tidy + gofmt
2. `make test` — unit tests under `internal/**`
3. `make integration` — integration tests under `test/integration/`,
   requires a local Postgres running via `docker compose up -d db`
4. `make lint` — golangci-lint with the repo's `.golangci.yml`
5. `make run` — start the service locally on port 8080

### Test expectations
- Every PR must include tests for new behavior
- Coverage must not drop below the baseline reported by `make cover`
- Flaky tests are fixed, never retried — use `t.Helper()` and
  deterministic fixtures

## Error Handling

- Handlers translate domain errors into HTTP statuses via the
  `internal/api/errs.Map` table. Unknown errors become 500 with a log
  entry tagged `unmapped_error`.
- The store layer never panics on query errors; it wraps them with the
  operation name and returns.
- Retry logic lives exclusively at the call site that owns the
  retry budget; lower layers propagate errors without retrying.

## Observability

- Structured JSON logs via `slog`, one event per log line
- Prometheus metrics exposed at `/metrics`; see `internal/api/metrics.go`
  for the registered families (request duration, error rate, inflight
  requests, event publish latency)
- Traces exported to the OTLP collector configured via
  `OTEL_EXPORTER_OTLP_ENDPOINT`; span names follow
  `widgetd.<layer>.<operation>`

## Security

- JWTs validated against the rotating JWKS endpoint at
  `AUTH_JWKS_URL`; keys cached for 10 minutes
- SQL queries use parameterized statements only; never string-concatenate
  user input
- Secrets come from environment variables managed by the deployment
  platform; never commit `.env` files

## Deployment

- Containerized via the multi-stage `Dockerfile` at the repo root
- Rollouts go through the platform's canary mechanism: 5% → 25% → 100%
  with 10-minute bake times
- Database migrations run as a separate job before the service rollout
  starts; failure aborts the rollout

## What Not To Do

- Do not add a new top-level package unless a domain concept genuinely
  doesn't fit the existing structure; prefer growing `internal/domain`
- Do not introduce a new ORM or query builder; the hand-rolled repository
  pattern is deliberate and load-bearing
- Do not add retries or circuit breakers below the handler layer
- Do not expand the public API surface in `pkg/client/` without an RFC
- Do not commit generated files except those checked in under
  `pkg/client/generated/`

## Known Quirks

- The `widgets.transfer_history` table has a denormalized
  `owner_chain` column kept in sync by a trigger; do not write to it
  directly
- The `/v2/widgets/search` endpoint uses a different pagination scheme
  than the rest of the API for historical reasons; consumers expect
  cursor-based pagination with opaque tokens
- Integration tests spin up Postgres via Docker rather than using
  `pgtest` because of a libpq compatibility issue on arm64 CI runners
