---
status: accepted
---

# Separate private operation from hostile repository execution

Keep the single-host deployment private to one operator while exposing only authenticated provider routes. A revocable operator login owns saved Session access; independent call-bound capabilities and signed callbacks permit successive Voice calls without granting dashboard or Build access to the provider.

Repository code and tests are potentially hostile, so execute them in a disposable Docker container behind a restricted launcher and model gateway. The launcher alone holds the Docker socket, the gateway holds the real model key, and the trusted Worker owns Git publication from independently validated output. This retains local operation with less deployment cost than a separate VM, while explicitly accepting Docker's shared-kernel risk and estimated rather than guaranteed billing limits.

Daily encrypted backups target a second disk/NAS and retain 14 days of history, with weekly disposable restore drills. Live raw transcripts expire after 30 days; encrypted copies may remain up to 44 days, and active frozen Build inputs survive until terminal. Restore applies retention, revokes restored logins and treats old queued attempts as uncertain generation. Strict 30-day erasure across old backups would require a different encryption/key-retention design.

## Consequences

The operator owns physical backup independence, a separately recoverable password, Docker updates and live acceptance configuration. Initial verified execution supports Node/npm with a lockfile and explicit tests; other toolchains remain discoverable but require additional isolated execution support. Saved Specs, pinned commits and confirmed scope remain resumable after transcript expiry. No cloud infrastructure, account-management system or automatic merge is introduced.
