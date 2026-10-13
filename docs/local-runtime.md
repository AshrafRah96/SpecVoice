# Local durable runtime

One operator-controlled host: Docker Compose and PostgreSQL. Private dashboard; separate provider ingress exposes only voice tools and signed post-call routes. Builds run untrusted repository code in disposable containers. Trusted Worker owns persistence, recovery, and GitHub publication.

## Set up and start

Install Node.js compatible with `package.json`, Docker Compose, and **Docker Engine 28 or newer**. Execution requires Docker's isolated bridge gateway mode; launcher rejects weaker networks. Reserve capacity for a 2-CPU, 4-GiB Build plus application and PostgreSQL.

```bash
npm ci
bash scripts/setup-local.sh
docker compose up --build -d
```

Wizard writes Compose's mode-0600 `.env`: operator passphrase hash, database password, service and call-capability secrets, provider credentials, optional backup configuration. Use `.env.local` for host development only. See [.env.local.example](../.env.local.example). Quote generated hashes literally so Compose does not interpolate `$` characters.

Sign in at [http://localhost:3000](http://localhost:3000). Operator cookies expire after eight hours and survive restarts; logout or passphrase-hash rotation revokes them. Sign in again to reopen Session history. Production requires PostgreSQL and configured operator authentication.

Route public HTTPS tunnels or reverse proxies **only to `127.0.0.1:3001`**, the provider ingress. Keep port 3000 private. `NEXT_PUBLIC_APP_URL`: public provider URL. `SPECVOICE_OPERATOR_ORIGIN`: private dashboard origin for write-request checks. These authentication boundaries differ. Both published Compose ports bind to loopback. PostgreSQL and execution control services publish no host ports.

Keep ElevenLabs agent private. Each call gets a fresh signed WebSocket URL and capability bound to that call and Session. Calls last at most 45 minutes; dashboard warns at 40 minutes. Tool capabilities expire after 60 minutes. Post-call delivery uses independent HMAC verification and durable call correlation; delayed callbacks do not require an unexpired tool capability. See [API reference](./api-reference.md) for replay and call-state behavior.

## Services and credentials

| Service              | Responsibility and access                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`                | Operator UI, call setup, discovery, Session APIs. Holds PostgreSQL access, operator hash, read-only GitHub token, ElevenLabs key, webhook HMAC secret, call-capability signing secret. |
| `provider-ingress`   | Forwards only permitted provider POST routes to `web`. No application credentials.                                                                                                     |
| `worker`             | Independent Build, profiling, post-call lanes; one Build at a time. Holds PostgreSQL access, GitHub publication token, internal service secret.                                        |
| `execution-launcher` | Owns Docker socket; creates/removes attempt containers. Holds internal service secret; receives attempt token. No database or provider key.                                            |
| `model-gateway`      | Holds real Anthropic key, PostgreSQL access, internal service secret. Checks attempt ownership, request policy, durable spending reservations before forwarding model requests.        |
| Disposable execution | Receives approved source, Spec/context, bounded attempt model token. No database URL, GitHub write credential, Docker socket, real provider key, host filesystem mount.                |
| `egress-proxy`       | Allows configured GitHub and package-registry hosts. No provider credentials.                                                                                                          |

Worker uses backend network for internal services and egress proxy for internet requests. Execution joins only the isolated execution network, reaching model gateway and egress proxy. Gateway reaches the real model endpoint. Keep `SPECVOICE_EGRESS_ALLOWLIST` narrow. Malicious code can send repository content to allowed destinations; the allowlist restricts destinations, not outgoing content.

Docker socket gives launcher host-level authority. Containers share the host kernel. Single-tenant isolation does not protect against all kernel or Docker vulnerabilities. Treat host and trusted services as security-sensitive. See [Security policy](../SECURITY.md).

## Build support and limits

Execution image pins Claude Code **2.1.296**; no host CLI needed. Builds require root `package.json`, `package-lock.json`, and nonempty `scripts.test`. Scope must include all installation and test inputs. Source transfer: at most 100,000 regular files and 64 MiB. Symlinks and submodules unsupported. Returned patches: 64-MiB expanded transfer limit. See [Claude execution](./agents/claude-code.md) for invocation and publication checks.

Default limits: 2 CPUs, 4 GiB memory, no additional swap, 256 processes, 2-GiB writable tmpfs under `/work`. Container runs as UID/GID 10001: read-only root filesystem, dropped capabilities, no new privileges. Total attempt deadline: 30 minutes. Claude retains a separate 15-minute timeout. Only trusted operator configuration can override limits; repository instructions cannot.

Install lifecycle scripts default off. `SPECVOICE_INSTALL_SCRIPT_REPOS` permits scripts for explicit repository URLs inside disposable containers. Final `npm test --ignore-scripts` remains mandatory; untrusted `scripts.test` still executes. Passing repository tests does not prove generated code safe.

Model gateway defaults: **US$5 estimated budget per attempt**, one request at a time, at most 100 requests. Gateway reserves conservative cost before forwarding, reconciles reported usage, and retains reservations for unknown usage. Hostile repository code can access the attempt token inside its container. Lease, expiry, request policy, and budget bound access. Provider billing and voice charges remain separate. Configure provider-side spending limits too.

Compose does not mount local repositories by default. `SPECVOICE_LOCAL_REPO_ROOT` alone grants no container access: local discovery requires explicit operator-managed mounts and matching allowed roots. Memory mode supports discovery and UI development only. Builds require PostgreSQL and isolated execution services.

## Restart, upgrade, and recovery

Web runs additive, checksum-checked migrations and retention before serving requests. Worker also migrates at startup. PostgreSQL advisory locking serializes migrations. Before upgrading, verify a backup and stop application services together; do not mix old and new workers:

```bash
docker compose stop web provider-ingress worker execution-launcher model-gateway
docker compose up --build -d
```

PostgreSQL preserves Sessions, event replay positions, receipts, and Build checkpoints across restarts. Expired Build leases enter reconciliation. Recovery checks recorded branch, commit, and PR; never automatically repeats interrupted generation. Missing trustworthy output requires an explicit new Build. Launcher removes orphaned attempt containers at startup; failed cleanup blocks publication. See [Build recovery](./build-pipeline.md) for retries.

Check health and durable state:

```bash
docker compose ps
docker compose exec worker npm run ops:status
```

Status reports worker heartbeats, Build/receipt counts, recent estimated model cost/latency, and latest backup, restore, and evaluation outcomes. Local measurements do not establish deployed usage or provider acceptance. `docker compose up --build -d` applies configuration changes; plain restart does not reload Compose environment values.

## Backups, retention, and verification

Use [Backups and retention](./backups.md) for encrypted daily second-disk/NAS backups, weekly restore drills, and **new** database recovery commands. Default live retention: transcripts 30 days, detailed metrics 180 days, Repository Profile caches seven days. Active Build inputs and encrypted backup history have documented exceptions.

See [Repository scale](./repository-scale.md) for profile budgets, explicit scope confirmation, and pinned-commit cache refresh. See [Evaluation](./evaluation.md) and [Manual smoke checks](./testing/manual-smoke.md) for offline gates, disposable PostgreSQL tests, Playwright, Docker isolation, and paid acceptance. Local checks do not establish live provider compatibility or recovery after the operator's backup disk fails.
