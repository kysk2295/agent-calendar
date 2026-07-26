# Production observability and readiness

## Purpose

Agent Calendar Gateway exposes three deliberately different operational surfaces:

| Surface | Access | Meaning |
| --- | --- | --- |
| `GET /api/health` | Public | The Node process can answer HTTP. It does not claim DB, AuthKit, or product readiness. |
| `GET /api/ready` | Public | Boolean production readiness with no component details. Returns 503 when any required check is false. |
| `GET /api/operations/status` | Operations bearer | Component checks, bounded request metrics, latency, availability, and SLO state. |

Railway liveness should use `/api/health`. Traffic promotion and deployment verification should use
`/api/ready`. Monitoring collectors should use `/api/operations/status`.

## Required production configuration

```text
WORKSPACE_AUTH_MODE=production
AGENT_CALENDAR_OPERATIONS_TOKEN=<independent random secret, 32–512 characters>
AGENT_CALENDAR_OBSERVABILITY_LOGS=1
AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT=200
AGENT_CALENDAR_REQUESTS_PER_WINDOW=600
AGENT_CALENDAR_REMOTE_REQUESTS_PER_WINDOW=1200
AGENT_CALENDAR_MAX_TRACKED_FINGERPRINTS=50000
AGENT_CALENDAR_REQUEST_WINDOW_MS=60000
AGENT_CALENDAR_JSON_BODY_MAX_BYTES=1048576
AGENT_CALENDAR_MULTIPART_BODY_MAX_BYTES=26214400
AGENT_CALENDAR_BODY_TIMEOUT_MS=30000
AGENT_CALENDAR_REQUEST_TIMEOUT_MS=120000
AGENT_CALENDAR_HEADERS_TIMEOUT_MS=15000
AGENT_CALENDAR_KEEP_ALIVE_TIMEOUT_MS=5000
```

The operations token must not be a WorkOS key, Workspace access token, Runner credential, provider
token, or the legacy Gateway bearer. Store it only in the deployment secret manager and monitoring
collector. The endpoint accepts an `Authorization: Bearer ...` header only; query-string tokens are
not supported.

Readiness additionally requires:

- a working PostgreSQL query;
- the Workspace-scoped product runtime and Runner/Calendar/Knowledge/Calendar AI/Automation services;
- configured WorkOS AuthKit adapter and public client identity;
- the operations token and redaction-safe request logging.

## Metrics contract

The monitor keeps a bounded in-memory window from the current process start:

- total and active requests;
- 5xx count;
- counts and total latency by HTTP method, registered route template, and status class;
- p95 latency, default target 2,000 ms;
- availability excluding caller-caused 4xx responses, default target 99.5%;
- `insufficient_data`, `meeting`, or `breached` SLO state.

Dynamic IDs are reduced to registered templates such as `/api/runs/:id`. Unregistered API paths use
`/api/unregistered`. Metrics and logs never include request bodies, query strings, headers, bearer
values, cookies, User IDs, Workspace IDs, or Runner IDs. Caller request IDs are retained only when
they are opaque hex/UUID values; all other values are replaced.

## Request safety contract

The Gateway enforces a final application-level safety boundary in production mode:

- JSON and multipart bodies are bounded by both declared `Content-Length` and actual streamed
  bytes. Overflow returns `413 PAYLOAD_TOO_LARGE`; chunked transfer cannot bypass the limit.
- A stalled body returns `408 REQUEST_BODY_TIMEOUT`.
- Each bearer receives a fixed-window request allowance keyed only by an in-memory HMAC digest.
  A separate remote-connection allowance is always applied first, so rotating untrusted bearer
  strings cannot bypass admission. Source values and digests are never returned or included in
  metrics. Exceeding either allowance returns
  `429 request_rate_limited` with `Retry-After`.
- Fingerprint storage is bounded. If the in-memory fingerprint table is full and no stale window
  can be reclaimed, a new fingerprint fails fast with `503 gateway_over_capacity` instead of
  allocating unbounded memory.
- A process-wide in-flight limit returns `503 gateway_over_capacity` before product work starts.
  Release is idempotent on response finish or disconnect.
- `GET /api/health` is admission-exempt so Railway can distinguish a live overloaded process from
  a crashed one. Readiness and product traffic remain limited.
- Node request, header, keep-alive, and body receive timeouts are explicitly bounded.

`GET /api/operations/status` exposes only aggregate request-safety counts:
`inFlight`, `accepted`, `rejectedRate`, and `rejectedCapacity`. These limits protect each process;
an external edge/WAF limit is still required to coordinate quota across multiple replicas.

## Initial alert policy

Run the Agent Calendar collector once per minute from a separate scheduler or monitoring service:

```sh
AGENT_CALENDAR_OPERATIONS_TOKEN="$OPERATIONS_TOKEN" \
node apps/backend/tools/phase10-operations-alert-collector.cjs \
  --base-url "$PRODUCTION_GATEWAY_URL" \
  --state-json "$COLLECTOR_STATE_PATH"
```

`COLLECTOR_STATE_PATH` must be on a persistent volume owned only by the collector process. The
collector writes a versioned 0600 atomic file containing only cumulative counters, rule streaks,
and active alert IDs. Missing state establishes the first baseline. Corrupt, oversized,
non-owner-only, or symlink state fails closed rather than silently resetting alert history.

The command prints one bounded `operations_alert_window` JSON object. It contains current
aggregate values, counter deltas, active alerts, and raised/resolved transitions. It never prints
the Gateway origin, operations token, response body, route inventory, User, Workspace, or Runner
identity.

- exit 0: no active P1 alert;
- exit 1: collector configuration, state, or response contract failure;
- exit 2: one or more active P1 alerts.

Configure the external scheduler or log/alert bridge to retain the JSON and route exit 2 or
`raised` transitions to the on-call destination. The collector itself does not send messages, so
PagerDuty/Grafana/Slack credentials never enter the Agent Calendar process.

The default rate-limit spike threshold is 100 new rejections per window. Override it only with a
reviewed baseline:

```sh
--rate-reject-threshold 250
```

The collector evaluates these rules once per window:

| Signal | Condition | Severity |
| --- | --- | --- |
| Deployment readiness | `/api/ready` is not 200 for 2 consecutive minutes | P1 |
| Availability SLO | `slo.state=breached` for 2 consecutive collection windows | P1 |
| Server errors | 5xx ratio exceeds 1% for 5 minutes | P1 |
| Latency | p95 exceeds 2,000 ms for 10 minutes | P2 |
| Collector auth | operations endpoint returns 401/503 after a deployment | P1 configuration incident |
| Admission pressure | `rejectedCapacity` increases in 2 consecutive windows | P1 |
| Caller abuse | `rejectedRate` spikes above the expected client retry baseline | P2 |

Do not page on `insufficient_data`; it is expected after restart until the minimum sample count is
reached. Do not treat `/api/health=200` as readiness evidence. A Gateway counter reset starts a
new delta baseline and cannot create a negative delta or a false capacity/error alert. Conditions
whose metrics are temporarily unavailable retain their previous state until a valid snapshot can
prove recovery.

## Incident check

1. Confirm `/api/health` and `/api/ready` separately.
2. Read `/api/operations/status` with the operations bearer.
3. Identify false checks without copying secret values or tenant data into the incident record.
4. Compare 5xx and p95 changes by route template.
5. Compare `rejectedRate` and `rejectedCapacity`; do not copy caller identity into the incident.
6. If a new release caused the change, roll back the Gateway while preserving the database.
7. Verify `/api/ready=200` before restoring traffic.

The Gateway in-memory window resets with the process. The single-run collector preserves alert
streaks and transitions outside the Gateway, while long-term metric retention, dashboard
visualization, on-call routing, and actual alert delivery remain deployment gates.
