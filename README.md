# SpecVoice

Private voice workspace: discuss a repository, produce a Spec, optionally build a draft PR. Discovery reads an immutable commit. Post-call Builds run Claude Code in disposable containers. A trusted Worker publishes changes for human review.

**Stack:** Next.js · TypeScript · ElevenLabs · Claude Code · PostgreSQL · Docker Compose.

## Architecture

![SpecVoice architecture: private voice discovery, durable PostgreSQL state, isolated Builds and trusted GitHub publication](docs/diagrams/specvoice-architecture.svg)

[Interactive Archify diagram](docs/diagrams/specvoice-architecture.html) · [Diagram source](docs/diagrams/specvoice-architecture.json). Download HTML and open locally; GitHub previews the SVG above.

## Local setup

Use Node from `.nvmrc` and Docker Engine 28+. Reserve capacity for a 2-CPU, 4-GiB Build plus the app and database.

```bash
npm ci
bash scripts/setup-local.sh
docker compose up --build -d
```

Wizard writes private `.env`, hashes the operator passphrase, generates secrets, and guides provider, disposable-repository and external-backup setup. Secrets stay local. Missing provider credentials disable that live path; configure them later.

Sign in at [localhost:3000](http://localhost:3000). Keep dashboard private. Expose only `localhost:3001` provider ingress through an HTTPS tunnel or reverse proxy. Set `NEXT_PUBLIC_APP_URL` to that public URL. Run `npm run setup:agent` after URL or agent-config changes. Enable ElevenLabs signed post-call webhooks; wizard links the steps.

`docker compose down` preserves database storage. Upgrade and restore steps: [local runtime](docs/local-runtime.md), [backup recovery](docs/backups.md). Never remove volumes holding saved Sessions.

## Product flow

1. Create or reopen a Session. URL survives reloads; history survives restarts.
2. Wait for Repository Profile. Bounded voice discovery can precede scope confirmation.
3. Discuss change. Agent reads permitted files, records decisions, produces a Spec.
4. Confirm required Scope Plans. Partial and mid/large profiles require explicit scope.
5. End call. Wait for signed transcript callback. Select **Build It**.
6. Review draft PR. Interrupted generation needs a new explicit Build; publication recovery never repeats Claude.

Calls: 45-minute maximum; continue with another call in the same Session. Logins: eight hours. Logout preserves accepted Builds. **Mark call failed** abandons a lost callback, retaining Specs and decisions.

## Verification

```bash
npm run verify              # format, types, lint, unit tests, production build
npm run eval:offline        # real application contracts, no paid providers
npm run test:e2e:install    # pinned Chromium
npm run test:e2e            # isolated browser server
npm run test:integration    # requires disposable TEST_DATABASE_URL ending in _test
npm run test:compose        # disposable complete deployment; requires Docker
npm run test:isolation      # real pinned Claude CLI, synthetic model transport
npm run test:backups        # requires image specvoice-backup:test
npm run bench:repositories # real Git snapshots, 5k–100k+ synthetic files
```

`test:compose` builds the image for `test:isolation`. Backup test image: `docker build --target backup -t specvoice-backup:test .`. Docker checks remove only their own resources. CI keeps evaluation and deployment artifacts.

Status: `docker compose exec worker npm run ops:status`. [Evaluation](docs/evaluation.md): prompt-version reports, spending estimates, separate live acceptance.

## Supported limits

Verified Builds: Node/npm, lockfile, explicit test command. Install lifecycle scripts default off. Source export: at most 64 MiB of regular tracked files. Workspace: 2 GiB default. No symlinks, submodules, Git LFS hydration or other build toolchains.

Single operator, single host. Docker shares host kernel. Model estimates cannot guarantee a billing ceiling. Synthetic checks do not prove customer impact, production load or paid voice/Build acceptance. External-disk recovery requires a mounted destination and separately recoverable password.

[Documentation map](docs/README.md) · [Agent contract](AGENTS.md) · [Security](SECURITY.md)

Built by [Ashraf Rahman](https://github.com/AshrafRah96).
