# Operational hardening delivery

Approved scope: single-operator, single-host Docker Compose deployment with PostgreSQL. Preserve existing Sessions, immutable snapshots, scope confirmation, durable events, and explicit post-call Builds. Use additive migrations; do not regenerate interrupted attempts automatically.

Implement and verify in this order:

1. **Operator and call boundaries:** eight-hour revocable login, private dashboard, saved Session history, private signed voice calls, 45-minute calls and 60-minute call capabilities, durable call identity and stale callback fencing. Verify actual authentication, browser resume, and PostgreSQL rollback.
2. **Independent runtime work:** keep one Build at a time while profiling and receipt processing progress independently. Add capped retry delay, cancellation, graceful shutdown, restart policy, and readiness based on durable heartbeat. Verify no starvation and recovery after unavailable storage.
3. **Hostile repository execution:** fixed-image Docker launcher, attempt-scoped model gateway credentials and estimated $5 budget, resource/deadline limits, Node/npm verification, restricted network, and trusted publication from fresh Git storage. Verify malicious repository cases in real containers.
4. **Retention and recovery:** scrub raw transcripts from all copies after 30 days, retain planning records, expire rebuildable indexes after seven days and metrics after 180 days. Support daily encrypted backups to a second disk/NAS, 14-day history, and weekly disposable restore drills with retention before startup.
5. **Operational evidence:** Compose smoke tests, versioned evaluations and usage history, synthetic repository benchmarks, and bounded live acceptance using a disposable repository and estimated $10 total provider budget.
6. **Guidance and setup:** refresh Graphify including directories it skips, correct docs/ADRs/skills, and provide a local setup wizard. Keep secrets out of chat and version control.

Each phase must pass focused regression checks and `npm run verify`. Browser changes require Playwright; persistence requires real PostgreSQL integration; execution isolation requires real Docker checks. No dependency overhaul, cloud deployment, automatic merging, or generic workflow framework.

External acceptance remains unverified until the operator configures credentials, a disposable GitHub repository, an external backup destination, and a separately saved recovery password. Docker shares the host kernel; this is not a VM isolation guarantee. Spend limits use estimates and cannot guarantee a billing ceiling. Encrypted backup copies of transcripts may survive up to 44 days in total; restored data must pass retention before serving the application.

## Verification ledger

- Phase 1: 330 unit, 24 PostgreSQL, and 5 browser tests; full verification passed.
- Phase 2: 337 unit and 27 PostgreSQL tests; full verification passed, including actual worker shutdown.
- Phase 3: pinned Claude Code 2.1.296 executed in a disposable Docker container with a synthetic model transport. Six model requests produced a committed patch and passing npm tests. Resource, filesystem, direct-egress, DNS, and workspace-quota probes passed; no paid requests. PostgreSQL gateway and trusted Git publication have separate regression coverage.
- Phase 3 final review: 13 additional HTTP launcher tests cover cancellation before creation, during creation, after output, lease loss, cleanup failure, and isolated bridge validation. Provider output is normalized before persistence so arbitrary command text cannot become a second transcript log.
- Phase 4: full verification passed (539 unit tests), 65 PostgreSQL checks and five browser tests passed. Real Docker/restic encrypted backup, disposable drill and fresh-database restore passed, including transcript removal, saved Spec/SHA/event identity, revoked logins, interrupted-attempt fencing, wrong-password and missing-volume rejection. A tiny fixture restored in 1.52 seconds; this does not establish production recovery time or physical disk-loss protection.
- Phase 5: real Compose smoke passed private authentication, durable Session/cookie/SSE replay after web/worker restart, provider-only ingress, unsigned callback rejection, worker readiness, allowed registry access and denied external egress. Synthetic Git-object benchmarks exercised 5,000, 25,000, 100,000 and 100,001 files; the last case correctly reports a partial 100,000-file inventory. Explicit scoped search returned only its 25 permitted files. These are local synthetic measurements, not a deployed workload or latency guarantee.
- Phase 5 evaluations: five offline fixtures execute application behavior and write versioned reports. Fifteen mocked live-runner tests cover budget reservation, report provenance, deadlines and provider failures. Real provider calls remain pending local setup; scheduled live evaluations are warning-only and recurring spending is separate from the initial acceptance budget.
- Phase 6: setup wizard, current runtime/security/API/extension guidance, repository skills and superseding ADR 0005 are updated. Wizard syntax and template-library identity pass; interactive credential entry and external backup provisioning are operator steps. Graphify refresh and a temporary architecture report capture source-verified topology and known extractor limits.
- Final verification on 2026-10-13: `npm run verify` passed with 572 tests and a production build; 67 real PostgreSQL integration tests, five Playwright tests and five offline fixtures passed. Docker Compose, isolated Claude execution and encrypted backup/restore checks passed independently. Verified implementation is preserved in the runtime commit; subsequent documentation delivery includes the Archify diagram.

## Remaining operator acceptance

Run `bash scripts/setup-local.sh` locally, then follow [bounded live acceptance](./evaluation.md) and [external backup recovery](./backups.md). Real voice/model/GitHub publication, independently stored recovery-key recovery, physical second-disk/NAS durability, and the production restore-time target are not established by the isolated checks above. No paid provider calls or deployment changes were made for this verification.
