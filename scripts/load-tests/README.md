Load tests for the backend reminder engine and analytics endpoints

Overview
- Two lightweight shell scripts are provided that use `npx autocannon` to drive load against the backend HTTP API.
- Scripts do not add dependencies to the repo; they rely on `npx autocannon` being available (installed transiently by `npx`).

Files
- `run-reminder-loadtest.sh` — public status check + admin-trigger (`POST /api/reminders/process`). Requires `ADMIN_API_KEY` env var.
- `run-analytics-loadtest.sh` — authenticated analytics endpoints (`/api/analytics/summary` and `/api/analytics/spending`). Requires `X_API_KEY` env var.

Representative scenarios
1. Light (smoke): `DURATION=10 CONCURRENCY=10 ./run-analytics-loadtest.sh`
2. Medium (normal load): `DURATION=30 CONCURRENCY=50 ./run-analytics-loadtest.sh`
3. Heavy (stress): `DURATION=60 CONCURRENCY=200 ./run-analytics-loadtest.sh`

Example commands
Export required keys and run a medium analytics load test:

```bash
export X_API_KEY="your-test-api-key"
export TARGET="http://localhost:3001"
DURATION=30 CONCURRENCY=50 PIPES=10 ./scripts/load-tests/run-analytics-loadtest.sh
```

Run reminder engine tests (requires admin key):

```bash
export ADMIN_API_KEY="your-admin-key"
export TARGET="http://localhost:3001"
DURATION=30 CONCURRENCY=50 PIPES=10 ./scripts/load-tests/run-reminder-loadtest.sh
```

Measuring bottlenecks
- Fetch ops/monitoring metrics before and after a run (requires `ADMIN_API_KEY`):

```bash
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" "$TARGET/api/admin/metrics/throughput?w=1" | jq .
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" "$TARGET/api/admin/metrics/latency?w=1" | jq .
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" "$TARGET/api/admin/metrics/retries?w=1" | jq .
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" "$TARGET/api/admin/health" | jq .
```

- Use database query plans for slow queries: backend has `scripts/capture-query-plans.js` and `scripts/benchmark-performance-indexes.js` to capture plans and run benchmarks.
- Enable Sentry profiling or sampling during a controlled run to capture CPU/stack traces (Sentry is configured in `backend/src/index.ts`).

Interpreting results and next steps
- Look for increased 5xx responses, long tail latency, DB connection pool exhaustion, and retry queue growth.
- If DB is the bottleneck, enable or tune the indexes found in `backend/migrations/20260527000000_add_performance_indexes.sql` and re-run benchmarks.
- If CPU/GC is the bottleneck, consider scaling worker processes, optimizing heavy queries, or offloading analytics to materialized views.
