# Claude Code integration

Read when changing the post-call executor, Claude CLI arguments, progress parsing, execution credentials, or subprocess lifetime. See [build pipeline](../build-pipeline.md) for acceptance, immutable inputs, scope, and recovery; [local runtime](../local-runtime.md) for deployment, credentials, and resource configuration. Provider-neutral contract: [AGENTS.md](../../AGENTS.md).

## Execution and publication ownership

Voice tools gather evidence and produce a Spec. An explicit Build freezes the pinned Repository Snapshot, confirmed Scope Plan, generation inputs, and unique attempt branch. The trusted Worker exports approved regular files into a disposable container through [IsolatedProcessRunner](../../src/lib/build/isolated-runner.ts). Repository scripts never run on the Worker or operator's host.

[The execution entry point](../../src/execution/attempt.ts) creates a fresh Git repository from those files, installs dependencies, runs Claude, then independently runs `npm test --ignore-scripts`. Input requires a root `package.json`, `package-lock.json`, and nonempty `scripts.test`. Selected scope must contain dependencies and configuration needed for those commands. Install lifecycle scripts stay disabled unless the operator explicitly permits that repository URL through `SPECVOICE_INSTALL_SCRIPT_REPOS`.

`SPEC.md` and `CONTEXT.md` are temporary inputs excluded through checkout-local `.git/info/exclude`. Existing input-file collisions are rejected. Repository content, transcripts, and these inputs are untrusted task data; they cannot grant broader execution permissions.

Claude creates the assigned local branch, implements the Spec, tests, and commits. The container returns a patch and successful verification result. Before accepting the patch, the Worker must confirm container removal and model-token revocation. [Publication](../../src/lib/build/publication.ts) applies the patch to the Worker-owned checkout at the pinned SHA, using trusted Git configuration with hooks disabled. It never imports the execution container's `.git` directory. Changed-path validation covers deletions and both sides of renames. Only the Worker pushes and opens a draft PR; human review remains required before merge or deployment.

Source export allows at most 100,000 files and 64 MiB. Reject source symlinks and submodules, generated symlink/submodule modes, unsafe paths, and oversized expanded patches. A temporary local commit can precede final scope validation; rejected changes cannot be published. Preserve cleanup on that failure path.

## CLI policy and subprocess lifetime

The execution image pins Claude Code **2.1.296** in [Dockerfile](../../Dockerfile) and [Compose](../../docker-compose.yml). The host and trusted runtime image need no Claude installation. [ClaudeProcessRunner](../../src/lib/build/process-runner.ts) owns the invocation; keep CLI flags there. Do not duplicate command strings in documentation.

The runner uses noninteractive print mode, default permissions with permission prompts disabled, bare mode, no settings sources, and empty strict MCP configuration. It selects `claude-sonnet-4-6`, permits at most 80 turns, and emits verbose stream JSON. Tools: Read, Write, Edit, and Bash only. Allowed Bash forms cover local Git status/diff/checkout/add/commit and `npm test`. No permission-bypass flag is enabled. The CLI budget option supplements the gateway's durable cost reservation; it is not the sole spending control.

| Operation                                       | Default bound                                    |
| ----------------------------------------------- | ------------------------------------------------ |
| Complete execution attempt and model credential | 30 minutes                                       |
| Claude subprocess                               | 15 minutes; 80 turns                             |
| Initial `npm ci`                                | 10 minutes                                       |
| Final `npm test --ignore-scripts`               | 5 minutes                                        |
| Git operation                                   | 120 seconds                                      |
| Disposable container                            | 2 CPUs, 4 GiB memory, 256 processes, 2 GiB tmpfs |

The total deadline bounds combined work; individual limits grant no extra time. Containers run as a non-root user with a read-only root filesystem, dropped capabilities, no additional swap, and no host mounts. The launcher requires an isolated Docker bridge network. Read [launcher configuration](../../src/execution-launcher.ts) and [execution limits](../../src/execution/limits.ts) before changing these controls.

Pre-cancelled operations must not spawn. On timeout or cancellation, terminate Unix process groups with `SIGTERM`, escalate to `SIGKILL` after five seconds, and await child closure before deleting temporary files. Kill surviving group members, clear timers, and detach signal listeners on every exit path. The supported Compose environment is Linux; the Windows subprocess fallback terminates only the direct child.

Await progress persistence before consuming more stdout. Storage failure aborts execution and invokes Build Attempt recovery. The parser rejects lines above 1 MiB and keeps a bounded stderr tail. The trusted runner persists fixed activity descriptions, never model-produced commands or repository text. It surfaces only approved execution errors.

## Model access and recovery

The execution container receives only a short-lived attempt credential as `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_BASE_URL` points to the internal model gateway. The real Anthropic key stays in the gateway. Database credentials, GitHub publication credentials, operator secrets, ElevenLabs keys, and the Docker socket stay outside execution.

Package subprocesses lose credential-shaped environment variables, but hostile code sharing the container may still obtain the attempt token. Treat that token as available to the repository. [The gateway](../../src/model-gateway.ts) checks the live Build lease, expiry, fixed model and request policy, and [durable budget reservations](../../src/lib/security/model-budget.ts) before forwarding. Defaults: US$5 estimated spend, at most 100 requests, and one request in flight. Unknown usage keeps its full reservation. A new token cannot reset an existing attempt's budget. These are application estimates; monitor provider pricing and billing separately.

[The Build Attempt module](../../src/lib/build/attempt.ts) owns lease renewal and recovery. Lost ownership aborts execution and prevents later publication or state changes. After interruption, reconcile recorded branch/commit/PR state without running Claude again. Missing generated output or legacy recovery metadata requires a new explicit Build. Recovery-only retry uses the existing Build route and cannot restart generation.

Docker isolation shares the host kernel, and the trusted launcher controls its Docker socket. Allowed egress destinations can receive content from malicious repository code. Keep human PR review, least-privilege credentials, and provider-side spending limits; deterministic permission tests do not prove an LLM resists prompt injection. Read [Security policy](../../SECURITY.md) when changing any of these boundaries.

For ElevenLabs SDK or voice-tool changes, use [ElevenLabs tool contracts](elevenlabs-tools.md) and installed SDK declarations. Signed post-call receipt acceptance and finalization belong at webhook and Session boundaries, independently of the Claude runner. See [API reference](../api-reference.md).
