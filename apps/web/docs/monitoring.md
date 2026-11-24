# Monitoring, health and alerting

The Web service exposes three endpoints and one structured log stream. They are served
by `apps/web/monitoring.mjs` and mounted in front of every other middleware in
`apps/web/serve-demo.mjs`, because the authentication gateway answers `421` to an
unrecognised origin and the client allowlist answers `403` before any route is chosen —
a probe arrives with no cookie, no `Origin` and no workspace header, so it must not have
to pass those gates.

```text
GET  /healthz   liveness   — is the process alive?                 always 200
GET  /readyz    readiness  — are the dependencies usable?          200 or 503
GET  /metrics   telemetry  — Prometheus text exposition format     200
```

All three accept only `GET` and `HEAD`; anything else answers `405` with
`Allow: GET, HEAD` and the body `{"error":"MethodNotAllowed","requestId":"…"}`.
Every response carries `X-Request-Id`, and the JSON bodies carry the same value as
`requestId`. Probe responses are `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`.

## Separation of liveness and readiness

`/healthz` must never depend on PostgreSQL, the object store or the disk. A liveness
probe that fails when a dependency fails makes the orchestrator restart a perfectly
healthy process, and a restart does not fix a database that is down. Liveness therefore
answers from process state only:

```json
{
  "status": "ok",
  "checkedAt": "2026-11-24T02:59:05.989Z",
  "startedAt": "2026-11-24T02:59:05.883Z",
  "uptimeSeconds": 0.106,
  "pid": 1314544,
  "version": "0894060b906",
  "requestId": "bd92387b-90a9-4a2d-8c9a-a7f9490ffec0"
}
```

`/readyz` probes the dependencies and answers `503` when a required one is unusable:

```json
{
  "status": "not_ready",
  "ready": false,
  "degraded": false,
  "checkedAt": "2026-11-24T03:01:12.402Z",
  "durationMs": 8,
  "cached": false,
  "checks": [
    { "name": "postgres", "required": true, "status": "down", "ok": false, "durationMs": 6,
      "error": { "category": "unreachable", "code": "ECONNREFUSED" }, "cached": false },
    { "name": "rustfs", "required": true, "status": "up", "ok": true, "durationMs": 5, "cached": false },
    { "name": "disk", "required": false, "status": "up", "ok": true, "durationMs": 1, "cached": false,
      "detail": { "availableBytes": 33285996544, "availableRatio": 0.3201 } },
    { "name": "backup", "required": false, "status": "up", "ok": true, "durationMs": 0, "cached": false,
      "detail": { "ageSeconds": 42 } }
  ],
  "requestId": "431f4930-86ee-48aa-a74b-063905342c56"
}
```

`status` is one of:

| `status` | HTTP | meaning |
| --- | --- | --- |
| `ready` | 200 | every required check passed |
| `ready_degraded` | 200 | required checks passed, an optional check failed |
| `not_ready` | 503 | at least one required check failed |

A check with `"status": "skipped"` did not run and is not a failure: a local-directory
deployment has no PostgreSQL and no object store, and reporting them as down would keep
that deployment permanently `not_ready`.

The body never contains a connection string, a password, an access key or a signed URL.
A dependency failure is reduced to `{category, code}`:

| `category` | driver codes / meaning |
| --- | --- |
| `timeout` | `ProbeTimeout`, `AbortError`, `UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT` |
| `unreachable` | `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `ECONNRESET`, `EPIPE` |
| `rejected` | `28P01` bad password, `28000` bad role, `Http401`, `Http403` |
| `missing_database` | `3D000` — the configured database does not exist |
| `forbidden` | `42501` — the role cannot read the schema |
| `upstream` | `Http5xx` from the object store |
| `error` | anything else, reported as `Unknown` |

Local checks (`disk`, `backup`) additionally report a redacted `reason` sentence, because
"Only 0MiB remain on /srv/log4stellar" is the actionable part of the answer and those
checks cannot contain a credential. The text still passes through the redactor and is
truncated to 512 characters.

## Probe timeout and caching

Two knobs, both integer milliseconds:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG4STELLAR_MONITOR_PROBE_TIMEOUT_MS` | `1500` | hard deadline for one probe round |
| `LOG4STELLAR_MONITOR_PROBE_CACHE_MS` | `5000` | how long a probe result is reused |

The caching is what keeps the probes from becoming the outage. A shared database role may have a small connection limit. Polling readiness
without caching can consume that budget across instances. Three properties make this safe:

1. **Results are cached, including failures.** A dead database is not re-dialled on every
   poll; the failure is reused for the cache window too, so a dependency that is down
   sees at most one connection attempt per 5 s per instance.
2. **Concurrent polls share one attempt.** The first caller installs an in-flight promise
   in the cache and every concurrent caller awaits it. Verified in the drill: 20 parallel
   `/readyz` requests produced 20 `"cached": true` answers and one real probe.
3. **Each probe opens its own tiny connection.** PostgreSQL is dialled with `max: 1`,
   `connectionTimeoutMillis`, `query_timeout` and `statement_timeout` all set to the probe
   timeout, and the pool is ended in `finally`. The probe never borrows from the request
   pool, so it cannot hold a connection while a request waits for one. The object store is
   dialled with `HeadBucketCommand`, `maxAttempts: 1` and both request timeouts set to the
   probe timeout, and the client is destroyed in `finally`.

`/metrics` recomputes the gauges on every scrape, which means a scrape also runs the
readiness probe — through the same cache, so a scrape and a readiness poll inside the same
5 s window share one probe round.

## Metrics

Prometheus text exposition format (`text/plain; version=0.0.4`), no extra dependency.

### Request metrics

| Metric | Type | Labels | Unit / meaning |
| --- | --- | --- | --- |
| `log4stellar_http_requests_total` | counter | `method`, `route`, `status_class` | requests served |
| `log4stellar_http_request_duration_seconds` | histogram | `method`, `route` | seconds; buckets 5 ms … 10 s |
| `log4stellar_http_client_errors_total` | counter | `route` | responses with a 4xx status |
| `log4stellar_http_server_errors_total` | counter | `route` | responses with a 5xx status |

`route` is a bounded label, never a path. `/sync/v1/workspace/file.md` becomes `sync`,
`/static/mount/…` becomes `workspace_files`, and anything unrecognised becomes `other`;
workspace IDs and file names never reach a label, so cardinality cannot grow with the
number of notes. The probe routes are deliberately excluded from the latency histogram:
they are scraped on a timer and would otherwise dominate the p99.

`method` is one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` or `OTHER`.
`status_class` is `1xx`, `2xx`, `3xx`, `4xx`, `5xx`.

### Dependency metrics

| Metric | Type | Labels | Unit / meaning |
| --- | --- | --- | --- |
| `log4stellar_dependency_up` | gauge | `dependency` | 1 up, 0 down |
| `log4stellar_dependency_probe_seconds` | gauge | `dependency` | seconds the last probe took |
| `log4stellar_dependency_errors_total` | counter | `dependency`, `category`, `code` | probe failures |
| `log4stellar_readiness_status` | gauge | `status` | always 1; the label carries `ready` / `ready_degraded` / `not_ready` |
| `log4stellar_pg_server_connections` | gauge | `state` = `total`/`idle` | sessions on the server for this database, from `pg_stat_activity` |
| `log4stellar_pg_server_waiting` | gauge | — | sessions waiting on a lock |

The server-side connection counts come from a best-effort
`SELECT … FROM pg_stat_activity WHERE datname = current_database()` that a role without
`pg_monitor` cannot read; the probe then omits those gauges and still answers for the
connection itself.

### Pool and backlog metrics

| Metric | Type | Labels | Unit / meaning |
| --- | --- | --- | --- |
| `log4stellar_pg_pool_connections` | gauge | `state` = `total`/`idle` | connections this process holds, summed over open workspace backends |
| `log4stellar_pg_pool_waiting` | gauge | — | callers queued for a connection **inside this process** |
| `log4stellar_workspace_backends_open` | gauge | — | workspace backends held open |
| `log4stellar_workspace_backends_opening` | gauge | — | workspace backends being opened now — the request backlog |
| `log4stellar_workspace_backends_limit` | gauge | — | the cache ceiling (default 8 with RustFS, 1 with the local backend) |

`log4stellar_workspace_backends_opening` is the queue-depth signal for this service. A
sustained value above zero means requests are waiting on backend construction, usually
because PostgreSQL is slow, not because the cache is too small.

`log4stellar_pg_pool_waiting` counts only this process. Server-wide contention is visible
in `log4stellar_pg_server_waiting` and in the `total` rows of
`log4stellar_pg_server_connections` approaching `rolconnlimit`.

### Process metrics

| Metric | Type | Labels | Unit / meaning |
| --- | --- | --- | --- |
| `log4stellar_process_resident_memory_bytes` | gauge | — | bytes of RSS |
| `log4stellar_process_heap_used_bytes` | gauge | — | bytes of V8 heap in use |
| `log4stellar_process_heap_total_bytes` | gauge | — | bytes of V8 heap committed |
| `log4stellar_process_external_memory_bytes` | gauge | — | bytes held by buffers outside the heap |
| `log4stellar_process_uptime_seconds` | gauge | — | seconds since this process started |
| `log4stellar_process_starts_total` | counter | `tracked` = `true`/`false` | recorded process starts |
| `log4stellar_build_info` | gauge | `version`, `backend` | always 1 |
| `log4stellar_disk_available_bytes` | gauge | `path` | free bytes on the monitored filesystem |
| `log4stellar_disk_total_bytes` | gauge | `path` | total bytes |
| `log4stellar_disk_available_ratio` | gauge | `path` | free space as a fraction, 0–1 |
| `log4stellar_disk_low` | gauge | `path` | 1 when below the configured floor |
| `log4stellar_backup_present` | gauge | — | 1 when a readable manifest was found |
| `log4stellar_backup_age_seconds` | gauge | — | age of the newest backup, or `-1` when none was found |

`log4stellar_disk_available_bytes` is `bsize × bavail` from `statfs`, which is the space
the service can actually write to as its own user, not the space the filesystem has.
`path` is a single configured directory, so the label cannot grow.

`log4stellar_backup_age_seconds` reads `manifest.json` in the backup directory
(`LOG4STELLAR_BACKUP_DIR`), accepting either the manifest directly in that directory or a
dated subdirectory below it, which is the layout `backup-data.mjs` produces. It never
parses anything else from the manifest and never returns `-1` unless no manifest exists.

`log4stellar_process_starts_total` increments once per start, recorded in
`process-starts.json` next to `auth.sqlite` in the auth directory. A restart gap is
visible as a jump between scrapes. When the state file cannot be written the metric still
exists with `tracked="false"` and a value of 1 so an alert does not silently stop
matching; the log line says why.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG4STELLAR_MONITOR_CLIENTS` | loopback only | comma-separated IPs, CIDRs or `localhost` allowed to call `/readyz` and `/metrics` |
| `LOG4STELLAR_MONITOR_PROBE_TIMEOUT_MS` | `1500` | per-probe deadline |
| `LOG4STELLAR_MONITOR_PROBE_CACHE_MS` | `5000` | probe result reuse window |
| `LOG4STELLAR_MONITOR_DISK_MIN_FREE_BYTES` | `0` (off) | free-byte floor for `log4stellar_disk_low`; set e.g. `536870912` for 512 MiB |
| `LOG4STELLAR_MONITOR_DISK_MIN_FREE_RATIO` | `0` (off) | free-space fraction floor for `log4stellar_disk_low`; set e.g. `0.05` |
| `LOG4STELLAR_MONITOR_DISK_REQUIRED` | unset | `1` makes a low disk fail readiness instead of only degrading it |
| `LOG4STELLAR_MONITOR_BACKUP_MAX_AGE_SECONDS` | `0` (off) | age above which the backup check degrades readiness; set e.g. `129600` for 36 h |
| `LOG4STELLAR_MONITOR_BACKUP_REQUIRED` | unset | `1` makes a stale or missing backup fail readiness |
| `LOG4STELLAR_MONITOR_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `LOG4STELLAR_MONITOR_STATE_FILE` | `<auth dir>/process-starts.json` | where the restart counter is kept |
| `LOG4STELLAR_BACKUP_DIR` | unset | directory holding `manifest.json`, directly or below dated subdirectories |

Both disk floors and the backup age default to `0`, which disables the check rather than
guessing a size for an unknown deployment — set them per deployment. `*_REQUIRED`
defaults are off on purpose: a full disk or an old backup is an operational
problem, not a reason for the orchestrator to pull an instance out of the load balancer
while it can still serve reads and writes. Turn them on per deployment once you have
decided that taking the instance down is the right response.

## Network exposure

- `/healthz` is served to every client and is safe to expose to a load balancer probe that
  arrives from any address.
- `/readyz` and `/metrics` answer `403` to any client outside loopback and
  `LOG4STELLAR_MONITOR_CLIENTS`. Set that variable to the Prometheus server and the
  orchestrator, e.g. `LOG4STELLAR_MONITOR_CLIENTS=127.0.0.1,192.0.2.0/24`. `*` is
  rejected rather than honoured, so a single typo cannot publish the metrics.
- `/metrics` describes uptime, memory and connection counts. It does not reveal a path, a
  workspace ID, a user name or a note title, but it is still an internal endpoint: keep it
  on the internal network alongside the scrape source.
- `/readyz` answers `403` outside the allowlist rather than `401`: there is no credential
  to present, and the caller only needs to know it is not on the list.

## Logs

One JSON object per line, written to stdout, UTF-8, `ts` always UTC ISO 8601 so lines from
several hosts sort lexically.

```json
{"ts":"2026-11-24T02:59:05.989Z","level":"info","msg":"monitoring: dependency probes configured","backend":"local","workspaceId":"log4stellar-main","timeoutMs":1500,"cacheMs":5000}
```

Request failures carry the request ID and the error class, never the error text:

```json
{"ts":"2026-11-24T03:04:11.002Z","level":"error","msg":"request failed","requestId":"692c8fcf-c42c-42fe-82ac-306912148b50","method":"POST","route":"workspace_files","errorCategory":"upstream","errorCode":"Http502"}
```

Field rules:

- `requestId` is taken from a valid incoming `X-Request-Id` (`[A-Za-z0-9._-]{8,64}`) and
  otherwise generated, so the value from a reverse proxy or a bug report can be grepped
  directly.
- The query string is dropped. It is the field most likely to carry a token.
- Any field whose name matches `pass`, `password`, `secret`, `token`, `authorization`,
  `cookie`, `credential`, `signature`, `apikey` or `api_key` is replaced by `[redacted]`,
  recursively to three levels.
- Text fields are scrubbed for URL userinfo, `X-Amz-Signature`, `X-Amz-Credential`,
  `X-Amz-Security-Token`, `sig=`, `token=`, `password=` and `secret=`, and truncated to
  512 characters.
- Note content, object keys and signed URLs are never logged; the service does not log a
  request body at any level.

Retention is a decision for the log collector, not the service; it writes to stdout and
rotates nothing. Keep at least 30 days of `level=error` lines to cover an incident that
starts at a weekend, and 7 days at `info`. Do not retain the raw stdout beyond that: at
`info` the service logs startup, probe configuration and request failures only, but the
collector is the place to enforce the policy.

## Suggested alert thresholds

Thresholds assume one scrape every 15 s and a 5 s probe cache. Every row names the
condition, the reason for the number, and whether it should page.

| Alert | Expression | For | Severity | Why this number |
| --- | --- | --- | --- | --- |
| Instance down | `up == 0` | 1 m | page | the process is not answering at all |
| Not ready | `log4stellar_readiness_status{status="not_ready"} == 1` | 2 m | page | longer than 2 probe cycles, so a cached blip does not page |
| PostgreSQL unreachable | `log4stellar_dependency_up{dependency="postgres"} == 0` | 2 m | page | writes are impossible; reads are already failing |
| Object store unreachable | `log4stellar_dependency_up{dependency="rustfs"} == 0` | 2 m | page | uploads and recoveries fail, existing files still read |
| Dependency rejected | `increase(log4stellar_dependency_errors_total{category="rejected"}[10m]) > 0` | 0 m | ticket | credentials rotated or role changed; a restart will not help |
| Server error rate | `sum(rate(log4stellar_http_server_errors_total[5m])) / sum(rate(log4stellar_http_requests_total[5m])) > 0.02` | 10 m | page | 2 % of requests failing is well above the observed baseline of ~0 |
| Request p99 | `histogram_quantile(0.99, sum by (le) (rate(log4stellar_http_request_duration_seconds_bucket[5m]))) > 2` | 10 m | ticket | 2 s is the point at which the workbench feels broken |
| Client error spike | `sum(rate(log4stellar_http_client_errors_total[5m])) > 1` | 10 m | ticket | usually a client release, not an outage |
| Pool waiters | `log4stellar_pg_pool_waiting > 0` | 5 m | page | requests are queuing for a connection inside this process |
| Server connections near the limit | `log4stellar_pg_server_connections{state="total"} > 8` | 5 m | page | `user_agent` has `rolconnlimit 10`; leave headroom for the probe and maintenance |
| Lock waits | `log4stellar_pg_server_waiting > 0` | 10 m | ticket | usually one long transaction; page only if it persists |
| Backend backlog | `log4stellar_workspace_backends_opening > 0` | 5 m | ticket | backend construction is slow, typically a slow database |
| Disk low | `log4stellar_disk_low == 1` | 10 m | page | fires only after a disk floor is configured; writes fail when the filesystem fills |
| Backup stale | `log4stellar_backup_age_seconds > 172800` | 30 m | page | 48 h without a backup is the real objective; set `LOG4STELLAR_MONITOR_BACKUP_MAX_AGE_SECONDS=129600` for 36 h |
| Restarts | `increase(log4stellar_process_starts_total{tracked="true"}[1h]) > 2` | 0 m | page | one restart is a deploy, three is a crash loop |
| Memory growing | `log4stellar_process_resident_memory_bytes > 1.5e9` | 30 m | ticket | baseline RSS is a few hundred MB; 1.5 GB means a leak or a huge workspace |
| Heap near the ceiling | `log4stellar_process_heap_used_bytes / log4stellar_process_heap_total_bytes > 0.9` | 15 m | ticket | V8 is about to spend its time collecting |

Two deliberate silences, both to keep the alert list trustworthy:

- A single failed probe never alerts. The 2 m `for:` window spans two cache cycles, so a
  restart of PostgreSQL that takes 3 s does not page anyone.
- `ready_degraded` never alerts on its own. It means an optional check failed while the
  service can still serve; the option-specific alert (disk, backup) covers it.

Notifications: page the on-call server operator for every `page` row; route `ticket` rows
to the normal work queue. The service has no notification path of its own — alerts are
computed by Prometheus and routed by Alertmanager, so the notification targets are
configured there and not in this repository.

## Failure location table

Start from the symptom, then follow the column. Every step is a command against the
instance, or a metric in the table above.

| Symptom | First check | Likely cause | Next step |
| --- | --- | --- | --- |
| Load balancer removes the instance | `/healthz` | the process died; liveness does not look at dependencies | check the exit code and the last `level=error` line |
| `/healthz` is fine, `/readyz` is 503, `postgres` down `unreachable` | `log4stellar_pg_server_connections{state="total"}` | PostgreSQL is down, or its host/port changed | check the service, then `LOG4STELLAR_STORAGE_CONFIG` |
| `postgres` down `rejected` `28P01` | the storage JSON | the database password was rotated | update the file and restart |
| `postgres` down `rejected` `28000` | `log4stellar_pg_server_connections` | `rolconnlimit 10` reached by another process | find the other consumer; do not raise the limit to hide it |
| `postgres` down `missing_database` `3D000` | the storage JSON | the `database` field names something that no longer exists | fix the field |
| `postgres` down `timeout` | `log4stellar_dependency_probe_seconds{dependency="postgres"}` | the database is up but not answering in 1.5 s | check the database's own load before raising the timeout |
| `rustfs` down `unreachable` | the storage JSON `s3.endpoint` | the object store is down or the endpoint host/port changed | check the service |
| `rustfs` down `rejected` `Http403` | the storage JSON `s3` keys | the access key was rotated or the policy changed | reissue a key scoped to the bucket |
| `rustfs` down `upstream` `Http5xx` | the object store's own logs | the object store is failing requests | follow its logs |
| `rustfs` down, `bucket` 404 in the object store | the bucket name | the bucket was renamed or deleted | recreate or repoint; do not create an empty bucket and assume recovery |
| `/readyz` 200 but pages fail | `log4stellar_http_server_errors_total` by `route` | the failure is in a route, not in a dependency | read the `requestId` from the error the user reported and grep it |
| Requests slow, `pg_pool_waiting` > 0 | `log4stellar_workspace_backends_opening` | this process is short of connections | check server-side contention before raising the pool size |
| Requests slow, `pg_pool_waiting` 0, p99 high | `log4stellar_http_request_duration_seconds` by `route` | one route is slow; often a large workspace read | find the route in the histogram and follow it |
| 4xx spike on `sync` or `workspace_files` | `log4stellar_http_client_errors_total` by `route` | a client release, or a workspace whose membership changed | confirm with the account and workspace involved |
| `disk_low` is 1 | `/readyz` `checks[disk].reason` | the filesystem is filling up | free space; the reason sentence names the path and the remaining MiB |
| `backup_age_seconds` grows | the backup job's own output | the backup job stopped, or it writes elsewhere | run `backup-data.mjs` manually and set `LOG4STELLAR_BACKUP_DIR` |
| `process_starts_total` jumps | the process supervisor | crash loop | read the exit reason; the counter is the fastest way to see it |
| `/metrics` answers 403 | `LOG4STELLAR_MONITOR_CLIENTS` | the scrape source is not on the list | add it; loopback is always allowed |
| A probe answers 200 but with `cached: true` for minutes | `log4stellar_dependency_probe_seconds` | the cache window is very long, or the process is not being asked to probe | check `LOG4STELLAR_MONITOR_PROBE_CACHE_MS` |

## Drills

The three failure modes below were exercised against a throwaway instance on ports
18991 and 18992 with throwaway dependencies; the production instance on port 18990 was
never touched. Reproduce them with `node /tmp/t10-drill/drill.mjs` and
`node /tmp/t10-drill/drill-disk.mjs` while those worktrees still exist.

| Drill | How | Result |
| --- | --- | --- |
| PostgreSQL down | `docker stop` the drill PostgreSQL container | `/healthz` 200, `/readyz` 503 `postgres=down(unreachable/ECONNREFUSED)`, `dependency_up{postgres}=0`, body free of the password |
| Object store down | `docker stop` the drill MinIO container | `/healthz` 200, `/readyz` 503 `rustfs=down(unreachable/ECONNREFUSED)`, body free of the secret key |
| Disk pressure | inject a `statfs` reporting 20 KiB free of 3.9 MiB | `/healthz` 200, `/readyz` 503 `disk=down` with the reason sentence, `disk_low=1`, `disk_available_bytes=20480` |

Recovery was reproduced in all three cases: bringing the dependency back (or freeing the
simulated filesystem) returned `/readyz` to 200 without a restart, and `disk_low` went
back to 0. That is the property the alert table depends on — the same metrics that fire
the alert also clear it.

The disk drill injects `statfs` rather than filling a filesystem. There is no root on this
host, mounting a small tmpfs is not possible, and filling the real filesystem would
endanger the production instance and every other worktree on the host. The injection point
is a documented seam in `checkDiskSpace`, and everything else in the drill — the koa
stack, the HTTPS server, the readiness evaluation, the cache, the Prometheus rendering —
is the production code path.

Concurrent-probe safety was measured in the same run: 20 parallel `/readyz` requests
produced 20 `"cached": true` answers and exactly one real probe round.

## Running the tests

```sh
node --test apps/web/monitoring.test.mjs
```

The unit tests cover the probe classification (including that a connection string never
reaches the response), the timeout and the single-flight cache, the Prometheus text
rendering, the route normaliser, the log redactor, the restart counter and the middleware
behaviour for each endpoint.
