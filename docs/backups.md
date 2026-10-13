# Local backups and retention

Default retention: raw transcripts 30 days, detailed metrics 180 days, Repository Profile caches seven days. Override through corresponding `SPECVOICE_*_RETENTION_DAYS` values. Worker sweeps hourly; web runs retention before serving requests. Database required: cleanup and startup fail closed.

Server-owned call creation time sets transcript age: `transcriptRecordedAt` in Session, event, and Build input copies. Migration 008 dates legacy copies from the earliest matching stored event, call, receipt, or Build timestamp it can establish. Session edits never restart retention. Cleanup preserves Specs, decisions, repository SHAs, Scope Plans, event IDs, receipt identities, and model-budget tombstones. Frozen inputs survive queued, running, and reconciling Builds until terminal; cleanup cannot invalidate accepted work. Provider-side retention remains separate.

Rebuild expired Repository Profiles explicitly from the dashboard at the original commit. Expiry preserves confirmed scope; never silently selects a newer commit. New model progress stores fixed activity descriptions, not arbitrary commands or transcript fragments.

## Configure the backup destination

Use `scripts/setup-local.sh`: configure second local disk or mounted NAS, recovery-password file, and mounted-volume marker. Set host UID/GID with password-file read access. Keep a recoverable password copy outside the application host. Losing the password loses encrypted backup access.

Backup override rejects absent bind sources. Every command checks the volume marker; unmounted destinations must not fall back to host disk. Marker confirms the expected filesystem is mounted, not physical disk independence. Operator must confirm paths use different physical disks.

```bash
# Initialize an empty encrypted repository once. Existing repositories are never reinitialized.
docker compose -f docker-compose.yml -f docker-compose.backup.yml run --rm backup init

# Start daily backups and weekly restore drills.
docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d backup

# Run either operation explicitly.
docker compose -f docker-compose.yml -f docker-compose.backup.yml run --rm backup once
docker compose -f docker-compose.yml -f docker-compose.backup.yml run --rm backup drill
```

Backup image contains PostgreSQL 16 tools and Restic. Logical PostgreSQL dumps stream directly into encrypted storage; no plaintext dump files. Successful backups prune history beyond 14 days. Failed backups preserve existing snapshots and record failure stage in `operational_runs`. Restic checks authenticated integrity before restore. See [Restic's backup protocol](https://restic.readthedocs.io/en/stable/040_backup.html), [retention](https://restic.readthedocs.io/en/stable/060_forget.html), and [restore](https://restic.readthedocs.io/en/stable/050_restore.html).

Encrypted transcript copies can outlive default live deletion by up to 14 days: up to 44 days total, plus the active-Build exception above. Offline or failed destinations cannot be pruned until available. Monitor failures; schedules do not guarantee retention.

## Restore without overwriting the live database

Stop work before real recovery. Restore to a **new** database named with prefix `specvoice_restore_`. Existing databases are rejected; never overwritten.

```bash
docker compose stop web provider-ingress worker execution-launcher model-gateway
docker compose -f docker-compose.yml -f docker-compose.backup.yml run --rm backup restore latest specvoice_restore_recovery
```

Restore checks encrypted repository, restores dump, applies additive migrations and retention, revokes restored operator cookies, and checks Session/event identities. Restored pending attempts enter reconciliation. Queued attempts may have executed since backup; without a publication checkpoint proving safe recovery, require an explicit new Build.

After success, set `POSTGRES_DB=specvoice_restore_recovery` in local Compose environment and recreate application services. Keep old database until recovered application and planning records pass review. Failed real restores retain their newly created database for diagnosis. Drills always remove their own temporary database after checking it.

Targets: at most 24 hours' data loss; measured 30-minute restore. Synthetic Docker checks cover encryption, restore, retention, identity preservation, and destructive-action guards. They cannot prove recovery from the operator's actual disk failure. External-destination recovery remains unverified until setup and a restore drill succeed there.
