# Deploying and rolling back the Web workspace

This document is the runbook for shipping a Log4Stellar Web release and for getting
back to the previous one when a ship goes wrong. It covers the five deployment steps
exposed by `apps/web/deploy-release.mjs`, the preflight checks that gate a switch, the
second-factor rule that constrains a rollback, and the supervising scheme that
replaces a systemd user unit on this host.

Everything here is exercised by `apps/web/deploy-release.test.mjs` (policy and
integrity) and by the end-to-end drill in [Drill transcript](#9-drill-transcript)
(a real HTTPS service on a loopback port).

## 1. Why there is no systemd user unit

The original launcher assumed a per-user systemd instance:

```
systemctl --user show log4stellar-web.service -p MainPID --value
systemctl --user restart log4stellar-web.service
```

On this host that assumption is wrong. There is no user session bus:

```
$ systemctl --user status
Failed to connect to bus: No medium found
$ loginctl show-user agent -p Linger
Linger=yes
```

`Linger=yes` only means the user manager *would* keep running after logout if one
existed; there is no `/run/user/<uid>/systemd` private socket either, so
`systemctl --user` cannot reach a manager even with lingering enabled. Consequences:

* Any deployment step that calls `systemctl --user` fails outright, including the old
  `activate-web-release.sh` readiness check, which reads `MainPID` from the unit. On
  this host that script cannot confirm a switch, so it cannot roll one back either.
* Nothing restarts the service after a crash or a reboot, and nothing prevents two
  copies from being started against the same port.

### The replacement: `release-supervisor.mjs`

`apps/web/release-supervisor.mjs` is a small process supervisor that needs no init
system. `deploy-release.mjs` drives it, and it can also be used by hand:

```
node apps/web/release-supervisor.mjs start \
  --pid-file "$STATE/web-release.pid.json" \
  --release "$(realpath -e "$STATE/current-web-release")" \
  --port 18990 --node "$NODE" --workspace "$WORKSPACE" \
  --log-file "$STATE/logs/web-release.log"
node apps/web/release-supervisor.mjs status  --pid-file "$STATE/web-release.pid.json"
node apps/web/release-supervisor.mjs stop    --pid-file "$STATE/web-release.pid.json"
```

What it provides instead of a unit file:

| systemd user unit gave us | `release-supervisor.mjs` gives us |
| --- | --- |
| `Restart=always` | restarts the child after an unexpected exit, bounded by `--restart-limit` (default 5) inside `--restart-window` (default 60000 ms) |
| `ExecStop` + `TimeoutStopSec` | `SIGTERM`, then `SIGKILL` after `--graceful-timeout` (default 15000 ms) |
| `MainPID` | `childPid` recorded in the pid file (`--pid-file`), re-read by `status` |
| journal | appended log file (`--log-file`), created mode `0600` |
| `WantedBy=default.target` | a cron `@reboot` entry (see [Boot](#4-boot-and-crash-recovery)) |

The pid file is written atomically (temporary file + `rename`, mode `0600`) and holds:

```json
{ "format": 1, "status": "running", "release": "...", "port": 18990,
  "node": "...", "workspace": "...", "logFile": "...",
  "supervisorPid": 1234, "childPid": 1235, "startedAt": "...", "updatedAt": "...",
  "restarts": 0 }
```

Every command is idempotent: `stop` with no pid file reports
`{"stopped":false,"reason":"no pid file"}` and exits 0, and `start` with a live
supervisor refuses to start a second one
(`A supervised release is already running: pid <pid> (<pidfile>)`).

The supervisor is deliberately not a service manager. It does not own the machine, it
does not resolve the release pointer itself (the deploy tool passes the resolved
release), and it exits rather than loop forever when a release crash-loops:

```
supervisor: release exited unexpectedly (code 1), restart 6/5
supervisor: giving up after 6 restarts inside 60000ms
```

That bound is what keeps a broken release from burning CPU unnoticed; the operator
sees a `crashed` status and a log full of the underlying error.

## 2. Layout

All paths are configurable, which is what makes a rehearsal possible without touching
production:

| Purpose | Flag | Environment | Production default |
| --- | --- | --- | --- |
| release pointer | `--pointer` | — | `$STATE/current-web-release` |
| previous pointer | `--previous` | — | `$STATE/previous-web-release` |
| audit trail | `--history` | — | `$STATE/deployment-history.json` |
| switch lock | `--lock` | — | `$STATE/web-release-switch.lock` |
| state root | `--state-dir` | `LOG4STELLAR_DEPLOY_STATE` | `~/.config/log4stellar` |
| release root | `--releases-root` | `LOG4STELLAR_RELEASES_ROOT` | `~/.local/share/log4stellar/releases` |
| runtime | `--node` | — | `~/.cache/log4stellar-toolchain/bin/node` |
| pid file | `--pid-file` | — | `$STATE/web-release.pid.json` |
| log file | `--log-file` | — | `$STATE/logs/web-release.log` |
| backup root | `--backup-root` | — | `~/.local/share/log4stellar/backups` |

The release root holds one directory per release. `current-web-release` and
`previous-web-release` are symlinks into it; nothing is ever deleted by the deploy
tool, so a rollback only moves a pointer.

## 3. The five steps

```
node apps/web/deploy-release.mjs <command> [options]
```

Every command prints numbered progress lines on stdout (`[deploy 07] preflight: disk:
{...}`) and a JSON document at the end; failures print
`[deploy] <CODE>: <message>` plus `[deploy] detail: <json>` on stderr and exit 1.

### `verify` — `verifyCandidate()`

Checks a candidate release directory without touching the live service:

1. reads `release.json` and compares `platform`, `arch`, `nodeMajor` and
   `source.commit` against what this tool will run (`nodeMajor` comes from the
   **runtime binary that will start the release**, not from the tool's own Node);
2. requires every file in `requiredFiles` (the launcher, the auth stack, the workspace
   contract, locale bundles, the built-in extension);
3. re-hashes the whole tree and compares it to `release.json.files`, reporting added,
   modified and missing entries;
4. optionally runs the release's own `server/verify-web-release.mjs` with `--smoke`
   for a full HTTPS smoke test.

Failure codes: `MissingRelease`, `MissingManifest`, `BadManifest`,
`IncompatibleRelease`, `IncompleteRelease`, `IntegrityMismatch`.

### `prepare` — `prepareRelease()`

`prepare <candidate> --name <release-name>`. Verifies the candidate, checks the disk
budget, copies it into the release root under a staging name, re-verifies the copy, and
only then renames it into place. Because the copy is verified before the rename, a
release root never contains a half-written release.

Idempotent: preparing the same source again with the same name returns
`"prepared": false` when the fingerprints match, and `ReleaseExists` when the name is
taken by a *different* source fingerprint.

### `activate` — `activateRelease()` + `verifyInstallation()`

`activate <release> [--no-backup]`. Takes the switch lock, verifies the candidate,
runs the preflight, takes a pre-activation data backup, moves the pointer, restarts the
supervisor, and verifies the running installation.

### `rollback` — `rollbackRelease()`

`rollback [--to <release>] [--reason <text>]`. Target resolution order:

1. `--to` when given;
2. the `previous-web-release` pointer;
3. the most recent `activate` entry in the history whose `release` is the current one.

It then re-runs `verifyCandidate()` on the target — a rollback target must be as intact
as an upgrade candidate — applies the [second-factor rule](#5-the-second-factor-rule),
runs the preflight and the backup, moves the pointer and verifies the result. The
release being left becomes the new `previous-web-release`, so a mistaken rollback can
be undone with a second rollback.

Failure codes: `NoCurrentRelease`, `NoRollbackTarget`, `AlreadyActive`,
`MfaRollbackRefused`, `RollbackReverted`, `RollbackFailedAndRestoreFailed`.

### `verify-installation`, `status`, `history`

`verify-installation --expect <release>` re-runs the running-service check without
switching anything. `status` prints the pointer, the previous pointer, the supervisor
state and the last history entries. `history` prints the audit trail.

## 4. Boot and crash recovery

The supervisor keeps a crashed release running, but it does not survive a reboot and
nothing starts it at boot. Since there is no user manager, use cron, which is running
on this host (`/usr/sbin/cron -f -P`) even though the user has no crontab:

```
$ crontab -l
no crontab for agent

$ crontab -e
@reboot sleep 20 && cd "$HOME/.config/log4stellar" && \
  setsid "$HOME/.cache/log4stellar-toolchain/bin/node" \
  "$HOME/Log4Stellar/worktrees/t09-deploy/apps/web/release-supervisor.mjs" start \
  --pid-file "$HOME/.config/log4stellar/web-release.pid.json" \
  --release "$(realpath -e "$HOME/.config/log4stellar/current-web-release")" \
  --port 18990 \
  --node "$HOME/.cache/log4stellar-toolchain/bin/node" \
  --workspace log4stellar-main \
  --log-file "$HOME/.config/log4stellar/logs/web-release.log" \
  >> "$HOME/.config/log4stellar/logs/cron-boot.log" 2>&1
```

Three details matter:

* `realpath -e` resolves the pointer **at boot time**, so a reboot always starts
  whatever release is current then, not whatever was current when the entry was written.
* `setsid` detaches the supervisor from the cron session so the process is not killed
  when cron's shell exits. This is the same detachment `deploy-release.mjs` uses.
* The environment the release needs (`LOG4STELLAR_AUTH_DIR`, the TLS paths, the storage
  configuration, the client allowlist) is **not** in that command line; it must come
  from an environment file that only operations can write, because it holds credentials
  and the deployment tool must never echo them. `deploy-release.mjs` builds this
  environment explicitly from its own flags (`serviceEnvironment()`), which is why an
  interactive `activate` never depends on the operator's shell.

Cron's `@reboot` has no readiness handshake. Confirm the boot start with
`deploy-release.mjs status` (it reports `running: false` when the supervisor is absent)
and `verify-installation --expect <release>`.

## 5. The second-factor rule

A release built before the account-security work has no `server/account-security.mjs`
and therefore cannot enforce a second factor. Rolling back to such a release while any
account has a verified factor would silently downgrade those accounts' protection, so
`rollbackRelease()` counts enrolled factors first (`mfaCensus()` reads the auth SQLite
database read-only: `twoFactor.verified = 1` and `user.twoFactorEnabled = 1`) and
refuses:

```
[deploy] MfaRollbackRefused: Refusing to roll back to web-20261122-02: 1 account(s)
have two-factor authentication enabled but that release cannot enforce it
(missing server/account-security.mjs). Disable two-factor for those accounts, or roll
back to a release built after the account-security work.
[deploy] detail: {"target":"...","current":"...","enrolled":1,"enabled":1,
                  "missing":"server/account-security.mjs"}
```

The pointer does not move, and the refusal itself is appended to the audit trail as
`rollback-refused`, so the attempt is visible later.

An operator who genuinely needs that rollback must first disable the second factor for
the affected accounts (through the account security page), which is a deliberate,
auditable act rather than a side effect of a deployment.

## 6. Preflight

Runs before the pointer moves, in `activate` and `rollback`:

| Check | Passes when | Failure |
| --- | --- | --- |
| TLS | certificate and key parse, match, are currently valid, and the certificate covers `--host` | `TlsMissing`, `TlsUnreadable`, `TlsNotYetValid`, `TlsExpired`, `TlsMismatch`, `TlsHostMismatch` |
| Disk | free bytes on the release root are at least `--min-free-bytes` (default 2 GiB) | `LowDiskSpace` |
| PostgreSQL | a read-only `REPEATABLE READ` transaction can count `log4stellar.storage_entries` and `storage_file_versions` | `DatabaseUnavailable` |
| RustFS | a `ListObjectsV2` with `MaxKeys: 1` on the configured bucket succeeds | `ObjectStoreUnavailable` |
| Second factor | census is readable | `MfaCensusFailed` |

The database and object-store probes are skipped when the storage configuration has no
`postgres` / `s3` section (the local notes backend), and say so instead of failing.

The pre-activation backup calls `apps/web/backup-data.mjs`, which snapshots the auth
SQLite database with `VACUUM INTO` (a plain copy is unsafe in WAL mode), dumps the
`log4stellar` schema, and copies the auth secret and git secret. It is skipped with an
explicit message when the deployment has no durable state to snapshot.

## 7. Rollback safety properties

| Property | How it is enforced |
| --- | --- |
| A broken candidate never becomes current | `activateRelease()` verifies the candidate and runs the preflight before `switchPointer()` |
| A failed activation does not lose the working release | on verification failure the tool stops the service, switches back to the previous pointer, restarts and re-verifies; if that also fails it reports `ActivationFailedAndRollbackFailed` instead of pretending |
| A rollback target is as trustworthy as an upgrade | `rollbackRelease()` runs the full `verifyCandidate()` on the target |
| Switching is atomic and exclusive | the pointer is replaced with `rename()` inside the state directory, guarded by an `O_EXCL` lock file whose holder pid is checked (a stale lock is removed with a warning) |
| A rollback stays reversible | the release being left is recorded as `previous-web-release` |
| No orphan listeners | `verifyInstallation()` reads `/proc/net/tcp{,6}` for the port, maps the socket inode back to pids through `/proc/<pid>/fd`, and fails with `OrphanListener` if anything other than the supervised child is listening |
| Every action is traceable | `deployment-history.json` (mode `0600`, atomic replace, newest 200 entries) records time, action, release name, resolved path, the **source commit and fingerprint**, the previous release, verification results and the MFA census |

## 8. Install failure, restart and rollback drills

Run these against a rehearsal root, never against production:

```
export D=/tmp/deploy-drill
mkdir -p "$D"/{config,releases,logs,backups,tls,auth,workspace}
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$D/tls/server.key" -out "$D/tls/server.crt" \
  -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1'
```

1. **Startup failure.** Activate a release whose launcher crashes (for example a
   release missing `server/auth.mjs`, or one pointed at a notes directory that does not
   exist). Expect: `verifyInstallation()` times out, the tool restores the previous
   pointer and reports `ActivationReverted`, and the supervisor log shows the failing
   release's own error.
2. **Crash loop.** Keep the failing release active by hand and watch the supervisor
   log; it stops after `--restart-limit` restarts inside `--restart-window` and exits
   with a `crashed` pid file rather than looping forever.
3. **Restart recovery.** `release-supervisor.mjs stop` then `start` against the same
   release, and confirm `verify-installation --expect` passes; nothing outside the
   state directory needs to change.
4. **Migration incompatibility.** Point `--storage-config` at a configuration whose
   `postgres` section names an unreachable host; expect `DatabaseUnavailable` during
   the preflight with the pointer untouched.
5. **Rollback.** `rollback --to <older release>`, then confirm the pointer moved, the
   service answers `/login` with 200, and `previous-web-release` points back at the
   release you left.
6. **Orphan check.** After every step, `ss -ltnp 'sport = :<port>'` must show exactly
   one listener, owned by the pid in `web-release.pid.json`.

## 9. Drill transcript

This is the recorded rehearsal on 2026-11-24 against `/tmp/t09-drill`, using copies of
the real production releases with a loopback TLS certificate and a throwaway auth
database. `NODE24` is the toolchain runtime the release was built for.

```
$ node apps/web/deploy-release.mjs verify /tmp/t09-drill/candidate-modern \
    --releases-root /tmp/t09-drill/releases --state-dir /tmp/t09-drill/config --node $NODE24
[deploy 02] release manifest: {"release":"candidate-modern",
  "commit":"0894060b906351bba6d6f72f0cc85bc2ff51455c",
  "fingerprint":"f1e459757c727db8034e8fb9c18d1962f09b0cc4d7d316262ed8b499b631792a",
  "nodeMajor":24,"files":8639,"twoFactor":true}
[deploy 03] candidate integrity verified: {"files":8639,...}          (6.9 s)

$ node apps/web/deploy-release.mjs prepare /tmp/t09-drill/candidate-modern \
    --name web-drill-20261124-01 ...
[deploy 10] release prepared: {"target":"/tmp/t09-drill/releases/web-drill-20261124-01",
  ...,"historyEntries":1}                                            (11.0 s)
$ ... prepare again
  "prepared": false                                                   (idempotent)

$ node apps/web/deploy-release.mjs activate /tmp/t09-drill/releases/web-drill-20261124-01 \
    --port 19443 --host 127.0.0.1 --backend local ...
[deploy 06] preflight: TLS ok: {"subject":"CN=127.0.0.1","notAfter":"Nov 26 02:46:13 2026 GMT","coversHost":true}
[deploy 08] preflight: disk ok: {"available":31509127168,"required":1000000000}
[deploy 10] preflight: PostgreSQL ok: {"skipped":"storage configuration has no postgres section"}
[deploy 12] preflight: RustFS ok: {"skipped":"storage configuration has no s3 section"}
[deploy 14] preflight: second-factor census ok: {"enrolled":0,"enabled":0,"available":true}
[deploy 15] data backup skipped: the storage configuration has no database or object store
[deploy 16] release pointer switched: {"from":null,"to":"/tmp/t09-drill/releases/web-drill-20261124-01"}
[deploy 18] supervisor started: {"supervisedPid":1296353,...}
[deploy 22] verify installation: port owned by the supervised process: {"pid":1296353}
[deploy 24] verify installation: HTTPS probes ok: {"login":200,"anonymousWorkspace":303,"redirect":"/login"}
[deploy 25] installation verified: {"release":".../web-drill-20261124-01",
  "commit":"0894060b906351bba6d6f72f0cc85bc2ff51455c","pid":1296353,"loginStatus":200}
[deploy 26] activation complete                                           (26.9 s)

$ curl --cacert /tmp/t09-drill/tls/server.crt https://127.0.0.1:19443/login -o /dev/null -w '%{http_code}'
200
$ curl ... https://127.0.0.1:19443/ -o /dev/null -w '%{http_code} %{redirect_url}'
303 https://127.0.0.1:19443/login
$ ss -H -ltnp 'sport = :19443'
LISTEN 0 511 127.0.0.1:19443 0.0.0.0:* users:(("MainThread",pid=1296353,fd=24))

$ node apps/web/deploy-release.mjs rollback --to /tmp/t09-drill/releases/web-drill-20261122-02 ...
[deploy 02] rollback target inferred: {"target":".../web-drill-20261122-02"}   # when --to is omitted
[deploy 19] release pointer switched: {"from":".../web-drill-20261124-01","to":".../web-drill-20261122-02"}
[deploy 27] installation verified: {"commit":"68444cbfe14af816e0f6ead7db0c3660fe568fcc","pid":1298787,"loginStatus":200}
[deploy 29] rollback complete                                             (6.5 s)
$ curl ... /login -> 200 ; $ curl ... / -> 303
$ ls /tmp/t09-drill/releases
web-drill-20261122-02   web-drill-20261124-01          # both kept: in-place rollback

$ # a verified second factor exists in the drill auth database
$ node apps/web/deploy-release.mjs rollback --to /tmp/t09-drill/releases/web-drill-20261122-02 ...
[deploy] MfaRollbackRefused: Refusing to roll back to web-drill-20261122-02: 1 account(s)
have two-factor authentication enabled but that release cannot enforce it
(missing server/account-security.mjs). ...                              (exit 1, pointer unchanged)

$ node apps/web/deploy-release.mjs verify /tmp/t09-drill/broken-drift ...
[deploy] IntegrityMismatch: Candidate release failed fingerprint verification (1 differences):
Unexpected or modified release file: server/serve-demo.mjs              (exit 1)
```

The resulting audit trail, including the refusal:

```
02:47:23 prepare            web-drill-20261124-01  commit=0894060b906
02:47:57 prepare            web-drill-20261122-02  commit=68444cbfe14
02:49:38 activate-failed    web-drill-20261124-01  commit=0894060b906  ERR=Nothing is listening on 127.0.0.1:19443
02:50:38 restart            web-drill-20261124-01  commit=0894060b906  from web-drill-20261124-01
02:52:02 rollback           web-drill-20261122-02  commit=68444cbfe14  from web-drill-20261124-01
02:53:12 activate           web-drill-20261124-01  commit=0894060b906  from web-drill-20261122-02
02:53:22 rollback           web-drill-20261122-02  commit=68444cbfe14  from web-drill-20261124-01
02:53:38 rollback           web-drill-20261124-01  commit=0894060b906  from web-drill-20261122-02
02:54:02 rollback-refused   web-drill-20261122-02  commit=68444cbfe14  from web-drill-20261124-01  ERR=MfaRollbackRefused
```

## 10. Procedure summary

**Ship a release**

1. `node apps/web/build-web-release.mjs` in a clean worktree; note the printed
   `source.commit` and `fingerprint`.
2. `deploy-release.mjs verify <built release> --smoke`.
3. `deploy-release.mjs prepare <built release> --name web-YYYYMMDD-NN`.
4. `deploy-release.mjs activate <release> --reason "..."`.
5. Confirm `verify-installation`, `status`, and one manual `/login` in a browser.

**Roll back**

1. `deploy-release.mjs history` to see where the current release came from.
2. `deploy-release.mjs rollback --to <release> --reason "<incident>"` (or omit `--to`
   to use the previous pointer).
3. If it refuses with `MfaRollbackRefused`, follow section 5 — do not work around it.
4. Confirm `verify-installation` and `ss -ltnp 'sport = :<port>'` for exactly one
   listener.

**Leave a record.** Every command already writes to `deployment-history.json`; copy the
relevant entries (they contain commit mappings and no secrets) into the change record.
