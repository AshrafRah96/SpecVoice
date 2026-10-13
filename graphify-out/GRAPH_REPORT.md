# Graph Report - SpecVoice  (2026-10-13)

## Corpus Check
- 242 files · ~111,802 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 9 file(s) not represented in the graph (top: (none) 8, .css 1)

## Summary
- 1337 nodes · 3447 edges · 80 communities (63 shown, 17 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 78 edges (avg confidence: 0.85)
- Token usage: host semantic extraction is unmetered by Graphify; zero counters are placeholders, not zero host usage. External provider calls: **0**.

## Graph Freshness
- Built from commit: `3cffa004`
- This graph includes the current working tree, including uncommitted source; the commit identifies its base only.
- Run `npm run graphify:refresh` after code changes; its process-local detector override retains source directories named `build`. Documentation semantics require the separate Graphify skill refresh and use host-agent tokens.

## Community Hubs (Navigation)
- Immutable Repository Sources
- Session Dashboard Components
- Encrypted Backup Operations
- Durable Runtime Transactions
- Agent Setup Guidance
- Repository Discovery Budgets
- Database Domain Schema
- Domain Architecture Decisions
- Project Task Commands
- Private Operator Authentication
- PostgreSQL Runtime Ownership
- PostgreSQL Session Persistence
- Session Build State
- Repository Tool Dispatch
- Scoped Tool Capabilities
- Build Attempt Recovery
- Model Budget Enforcement
- Isolated Build Architecture
- Local Setup Wizard
- Bounded Claude Execution
- Publication Scope Tests
- Compose Browser Verification
- Shared Session Types
- Project Runtime Configuration
- Session Build Routes
- Trusted Git Workflow
- Operator Setup Recovery
- TypeScript Compiler Configuration
- Development Tool Dependencies
- Offline Contract Evaluations
- Isolated Patch Publication
- Session Data Retention
- Execution Container Launcher
- Durable Build Queue
- Browser Build Verification
- Draft PR Publication
- Build Complexity Validation
- Application Runtime Dependencies
- Launcher Cancellation Tests
- Dashboard Component Configuration
- ElevenLabs Agent Setup
- Leased Worker Loops
- Model Gateway Integration
- Isolated Compose Topology
- Live Agent Evaluations
- Bounded Container Attempt
- Local Runtime Guidance
- Provider Ingress Security
- Build Executor Interfaces
- Build Workflow Execution
- Operator Login State
- Security Agent Contracts
- Credential Model Gateway
- Signed Postcall Finalization
- Voice Tool Extensions
- Session Call State
- Isolated Runner Verification
- Offline Evaluation Reports
- Postcall Queue Adapters
- Decision Spec Generation
- Live Evaluation Reports
- Sample Repository Dependencies
- Sample Repository Code
- Historical Production Research
- Source Formatting Policy
- Voice Audio Smoke
- ElevenLabs SDK Compatibility
- JavaScript Lint Configuration
- Application Root Layout
- Graphify Coverage Refresh
- Operations Ledger Schema
- Next.js Application Configuration
- Tailwind Styling Configuration
- Budgeted Nightly Evaluations
- Transcript Retention Schema
- Sample Repository Documentation

## God Nodes (most connected - your core abstractions)
1. `Session` - 66 edges
2. `sessionStore` - 55 edges
3. `vitest` - 53 edges
4. `PostgresSessionRepository` - 43 edges
5. `next` - 36 edges
6. `scripts` - 29 edges
7. `Documentation map` - 29 edges
8. `runtimePool()` - 28 edges
9. `getRepositorySnapshotStore()` - 27 edges
10. `getSessionRepository()` - 27 edges

## Surprising Connections (you probably didn't know these)
- `containerArgs()` --calls--> `executionContainerArgs()`  [EXTRACTED]
  tests/lib/security/service-boundaries.test.ts → src/execution-launcher.ts
- `leasedRepository()` --calls--> `PostgresSessionRepository`  [EXTRACTED]
  tests/integration/durable-runtime.test.ts → src/lib/session/postgres-repository.ts
- `mockGitHub()` --calls--> `GitHubCodeSource`  [EXTRACTED]
  tests/code/github-source.test.ts → src/lib/code/github-source.ts
- `reserve()` --calls--> `requestReservation()`  [EXTRACTED]
  tests/lib/security/model-budget.test.ts → src/lib/security/model-budget.ts
- `makeRequest()` --calls--> `issueSessionCapability()`  [EXTRACTED]
  tests/api/tool-handler.test.ts → src/lib/session/capability.ts

## Import Cycles
- None detected.

## Communities (80 total, 17 thin omitted)

### Community 0 - "Immutable Repository Sources"
Cohesion: 0.05
Nodes (52): ignore, DISCOVERY_LIMITS, operationBudget(), BlobEntry, Budget, GitHubCodeSource, handleRateLimit(), createIgnoreFilter() (+44 more)

### Community 1 - "Session Dashboard Components"
Cohesion: 0.07
Nodes (42): class-variance-authority, clsx, @elevenlabs/react, @radix-ui/react-slot, react, tailwind-merge, BuildPanel(), groupLabel() (+34 more)

### Community 2 - "Encrypted Backup Operations"
Cohesion: 0.16
Nodes (23): migrate(), createPool(), backupOnce(), commands(), finishRun(), initializeBackup(), postgres(), repository() (+15 more)

### Community 3 - "Durable Runtime Transactions"
Cohesion: 0.10
Nodes (20): transaction(), PostCallInput, PostgresRepositorySnapshotStore, snapshotFor(), RepositoryProfile, builds, createBuildSession(), enqueueBuild() (+12 more)

### Community 4 - "Agent Setup Guidance"
Cohesion: 0.08
Nodes (28): Provider-neutral agent contract, Claude Code guidance adapter, Contribution workflow, ADR 0001: canonical agent contract, Disposable Docker execution, Separate private operation from hostile repository execution, Encrypted second-disk backups, Revocable operator login (+20 more)

### Community 5 - "Repository Discovery Budgets"
Cohesion: 0.15
Nodes (22): POST, POST, schema, InMemoryCodeSource, codeSourceRegistry, registerCodeSource(), classify(), extension() (+14 more)

### Community 6 - "Database Domain Schema"
Cohesion: 0.11
Nodes (25): build_attempts, one_active_attempt, queued_attempts, session_events, session_events_replay, sessions, post_call_jobs, post_call_jobs_claim (+17 more)

### Community 7 - "Domain Architecture Decisions"
Cohesion: 0.09
Nodes (26): Build Attempt implementation guide, Dashboard implementation guide, Isolated browser verification guide, ADR 0002: post-call execution boundary, Historical ADR 0003: superseded memory deployment, ADR 0004: initial durable runtime refined by ADR 0005, Canonical CI verification workflow, Build Attempt (+18 more)

### Community 8 - "Project Task Commands"
Cohesion: 0.07
Nodes (29): scripts, backup, bench:repositories, build, db:migrate, dev, egress-proxy, eval:offline (+21 more)

### Community 9 - "Private Operator Authentication"
Cohesion: 0.18
Nodes (17): DELETE, POST, GET, Home(), derive(), getOperatorAuth(), hashOperatorPassphrase(), OPERATOR_COOKIE (+9 more)

### Community 10 - "PostgreSQL Runtime Ownership"
Cohesion: 0.19
Nodes (13): pg, GET(), runtimePool(), StorageUnavailable, workerHeartbeat(), workerReady(), getPostCallQueue(), PostCallJob (+5 more)

### Community 13 - "Repository Tool Dispatch"
Cohesion: 0.22
Nodes (20): GET, GET, POST, GET, POST, schema, errorResponse(), parseRequestBody() (+12 more)

### Community 14 - "Scoped Tool Capabilities"
Cohesion: 0.15
Nodes (18): Context, DELETE, POST, CALL_DURATION_SECS, getSessionCalls(), capabilityFromRequest(), DEVELOPMENT_SECRET, encode() (+10 more)

### Community 15 - "Build Attempt Recovery"
Cohesion: 0.11
Nodes (7): AttemptExecution, BuildPipeline, FakeProcessRunner, StubWorkflowSteps, AttemptPhase, BuildJob, setup()

### Community 16 - "Model Budget Enforcement"
Cohesion: 0.13
Nodes (16): cacheControl, contentBlock, count, ModelBudget, ModelBudgetError, ModelReservation, ModelUsage, rejectSources() (+8 more)

### Community 17 - "Isolated Build Architecture"
Cohesion: 0.09
Nodes (20): Build Attempt module, ClaudeProcessRunner, Claude Code integration, IsolatedProcessRunner, Model gateway, Trusted Git publication, CodeSource, Architecture (+12 more)

### Community 18 - "Local Setup Wizard"
Cohesion: 0.21
Nodes (22): ask(), ask_secret(), banner(), _clear(), confirm(), _existing(), finish(), note() (+14 more)

### Community 19 - "Bounded Claude Execution"
Cohesion: 0.13
Nodes (10): ClaudeOutputParser, ClaudeStreamEvent, detailFromInput(), ParseResult, phaseFromTool(), ClaudeProcessRunner, FakeProgress, ProcessRunner (+2 more)

### Community 20 - "Publication Scope Tests"
Cohesion: 0.17
Nodes (10): vitest, makeDecision(), makeSession(), commit(), git(), makePatch(), session(), commit() (+2 more)

### Community 21 - "Compose Browser Verification"
Cohesion: 0.12
Nodes (15): maxConnections, port, privateAddress(), rules, server, allowedHost(), main(), redactions (+7 more)

### Community 22 - "Shared Session Types"
Cohesion: 0.22
Nodes (13): guardBuildTransition(), VALID_TRANSITIONS, AttemptLease, BuildPhase, BuildStatus, ComplexityAssessment, Decision, FileRead (+5 more)

### Community 23 - "Project Runtime Configuration"
Cohesion: 0.10
Nodes (19): engines, node, typescript, zod, name, private, version, autoprefixer (+11 more)

### Community 24 - "Session Build Routes"
Cohesion: 0.18
Nodes (13): next, pipeline, GET, withOperator(), requireInMemorySessionStore, requireSessionStorage(), withSessionStorage(), makeRequest() (+5 more)

### Community 25 - "Trusted Git Workflow"
Cohesion: 0.21
Nodes (10): buildCloneArgs(), cleanupTmpDir(), cloneRepo(), pushBranch(), runGit(), withCredentials(), validateChangedPaths(), CreatePRInput (+2 more)

### Community 26 - "Operator Setup Recovery"
Cohesion: 0.12
Nodes (16): Local backups and retention, Restic, Disposable restore drill, Transcript retention, Evaluation, Live acceptance, Live evaluation reservation ledger, Offline behavioral evaluations (+8 more)

### Community 27 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 28 - "Development Tool Dependencies"
Cohesion: 0.11
Nodes (18): devDependencies, autoprefixer, eslint, eslint-config-next, @playwright/test, postcss, prettier, tailwindcss (+10 more)

### Community 29 - "Offline Contract Evaluations"
Cohesion: 0.20
Nodes (7): ToolHandler, toolRegistry, EvalCaseSchema, evaluateOfflineCase(), loadOfflineEvalCases(), runOfflineEvaluations(), buildReadiness()

### Community 30 - "Isolated Patch Publication"
Cohesion: 0.19
Nodes (12): executionError(), IsolatedProcessRunner, progressDetails, safeExecutionErrors, UnconfiguredProcessRunner, RunOpts, applyExecutionPatch(), checkPatchBudget() (+4 more)

### Community 31 - "Session Data Retention"
Cohesion: 0.18
Nodes (14): expiredTimestamp(), retainedTranscript(), retentionPolicy(), runRetention(), pool, call(), daysAgo(), jobs (+6 more)

### Community 32 - "Execution Container Launcher"
Cohesion: 0.19
Nodes (14): createExecutionLauncher(), docker(), exec, executionContainerArgs(), inputSchema, positive(), removeContainer(), ISOLATION_FIXTURE_TOKEN (+6 more)

### Community 33 - "Durable Build Queue"
Cohesion: 0.21
Nodes (5): executeBuildAttempt(), PostgresPostCallQueue, PostgresBuildQueue, main(), claimBuild()

### Community 34 - "Browser Build Verification"
Cohesion: 0.23
Nodes (9): @playwright/test, @vitejs/plugin-react, createLocalSession(), driveSessionToReady(), fixturePath, buildSignedPostCallRequest(), signWebhookPayload(), TEST_WEBHOOK_SECRET (+1 more)

### Community 35 - "Draft PR Publication"
Cohesion: 0.16
Nodes (5): @octokit/rest, createDraftPR(), remoteBranchCommit(), RealWorkflowSteps, parseOwnerRepo()

### Community 36 - "Build Complexity Validation"
Cohesion: 0.18
Nodes (8): validateBuild(), ValidationResult, assessComplexity(), charCountEstimator(), groupByTopLevelDir(), SIZE_THRESHOLDS, SizeEstimator, sizeFromLineEstimate()

### Community 37 - "Application Runtime Dependencies"
Cohesion: 0.13
Nodes (15): dependencies, class-variance-authority, clsx, @elevenlabs/elevenlabs-js, @elevenlabs/react, geist, ignore, next (+7 more)

### Community 38 - "Launcher Cancellation Tests"
Cohesion: 0.14
Nodes (7): fakeChild(), finish(), input, mocks, releases, result, secret

### Community 39 - "Dashboard Component Configuration"
Cohesion: 0.14
Nodes (13): aliases, components, utils, rsc, $schema, style, tailwind, baseColor (+5 more)

### Community 40 - "ElevenLabs Agent Setup"
Cohesion: 0.20
Nodes (5): @elevenlabs/elevenlabs-js, systemPrompt, SESSION_ID_PROP, SESSION_TOKEN_PROP, main()

### Community 41 - "Leased Worker Loops"
Cohesion: 0.20
Nodes (4): runWorkerLoops(), wait(), WorkerLane, WorkerLoopCallbacks

### Community 42 - "Model Gateway Integration"
Cohesion: 0.16
Nodes (9): attempt(), budget, capability(), events(), message, pool, repository, servers (+1 more)

### Community 43 - "Isolated Compose Topology"
Cohesion: 0.24
Nodes (10): Local encrypted-backup service configuration, Single-host Compose configuration, Pinned execution image, Model gateway service, Provider ingress service, Docker execution launcher service, PostgreSQL service, Allowlist egress proxy service (+2 more)

### Community 44 - "Live Agent Evaluations"
Cohesion: 0.18
Nodes (10): CriterionResult, ledgerSchema, LiveEvalReport, LiveReservation, main(), reserveLiveEvalBudget(), score(), SIMULATION_CRITERIA (+2 more)

### Community 45 - "Bounded Container Attempt"
Cohesion: 0.27
Nodes (10): ContainerAttemptInput, executeContainerAttempt(), inputSchema, main(), runNpm(), validateInput(), executionDeadlineMs(), file() (+2 more)

### Community 46 - "Local Runtime Guidance"
Cohesion: 0.18
Nodes (12): API Reference, Durable SSE replay, Operator login cookie, Post-call receipt, Private Voice call, Local durable runtime, Execution launcher, Isolated execution network (+4 more)

### Community 47 - "Provider Ingress Security"
Cohesion: 0.20
Nodes (7): createProviderIngress(), providerPaths, publicProviderRoute(), path(), containerArgs(), limitNames, token

### Community 48 - "Build Executor Interfaces"
Cohesion: 0.29
Nodes (7): buildBranchName(), checkPrerequisites(), slugify(), writeBuildFiles(), PrereqCheck, RepositoryMethod, SessionRepository

### Community 50 - "Operator Login State"
Cohesion: 0.39
Nodes (4): configuredHash(), digest(), OperatorAuth, OperatorAuthError

### Community 51 - "Security Agent Contracts"
Cohesion: 0.20
Nodes (5): ElevenLabs SDK integration guide, Private voice and completion guide, Voice call, Session capability, Security policy

### Community 52 - "Credential Model Gateway"
Cohesion: 0.51
Nodes (7): bearer(), readServiceJson(), serviceAuthorized(), serviceJson(), createModelGateway(), createIsolationModelFixture(), main()

### Community 53 - "Signed Postcall Finalization"
Cohesion: 0.22
Nodes (6): POST, PostCallPayloadSchema, TranscriptTurnSchema, env, envSchema, parsed

### Community 54 - "Voice Tool Extensions"
Cohesion: 0.20
Nodes (10): Extending SpecVoice, SessionRepository, Shared tool handlers, ElevenLabs tool definition, Agent tool extension, Agent toolIds, Personality, Voice feature planning (+2 more)

### Community 55 - "Session Call State"
Cohesion: 0.27
Nodes (3): SessionCallError, SessionCalls, setup()

### Community 56 - "Isolated Runner Verification"
Cohesion: 0.22
Nodes (3): gateway(), git(), patch()

### Community 57 - "Offline Evaluation Reports"
Cohesion: 0.31
Nodes (6): OfflineEvalCase, main(), OfflineEvalReport, runOfflineEvalReport(), commit, fixture

### Community 58 - "Postcall Queue Adapters"
Cohesion: 0.22
Nodes (3): MemoryPostCallQueue, PostCallQueue, receiptKey()

### Community 59 - "Decision Spec Generation"
Cohesion: 0.44
Nodes (6): categorizeDecision(), classifiers, DecisionClassifier, decisionsTable(), escapeCell(), generateSpec()

### Community 60 - "Live Evaluation Reports"
Cohesion: 0.28
Nodes (7): directory(), constructor(), criteria, digest(), fixture, ledger(), reports()

### Community 61 - "Sample Repository Dependencies"
Cohesion: 0.25
Nodes (7): dependencies, typescript, zod, typescript, zod, name, version

### Community 62 - "Sample Repository Code"
Cohesion: 0.32
Nodes (3): user, User, greet()

### Community 63 - "Historical Production Research"
Cohesion: 0.33
Nodes (6): Claude Code secure deployment guidance, SpecVoice production-readiness research, Historical durable control plane recommendation, GitHub Git Trees API documentation, PostgreSQL NOTIFY documentation, Historical repository intelligence recommendation

### Community 64 - "Source Formatting Policy"
Cohesion: 0.33
Nodes (5): arrowParens, printWidth, semi, singleQuote, trailingComma

### Community 66 - "ElevenLabs SDK Compatibility"
Cohesion: 0.50
Nodes (4): ElevenLabs SDK — Undocumented Behavior & Workarounds, ElevenLabs dynamicVariables, SDK camelCase field names, Tool parameter dynamicVariable

## Knowledge Gaps
- **333 isolated node(s):** `singleQuote`, `semi`, `arrowParens`, `trailingComma`, `printWidth` (+328 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 469 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `Publication Scope Tests` to `Immutable Repository Sources`, `Encrypted Backup Operations`, `Durable Runtime Transactions`, `Repository Discovery Budgets`, `Private Operator Authentication`, `PostgreSQL Runtime Ownership`, `Scoped Tool Capabilities`, `Build Attempt Recovery`, `Model Budget Enforcement`, `Bounded Claude Execution`, `Compose Browser Verification`, `Shared Session Types`, `Project Runtime Configuration`, `Session Build Routes`, `Trusted Git Workflow`, `Offline Contract Evaluations`, `Session Data Retention`, `Browser Build Verification`, `Build Complexity Validation`, `Launcher Cancellation Tests`, `Leased Worker Loops`, `Model Gateway Integration`, `Bounded Container Attempt`, `Provider Ingress Security`, `Signed Postcall Finalization`, `Isolated Runner Verification`, `Offline Evaluation Reports`, `Decision Spec Generation`, `Live Evaluation Reports`?**
  _High betweenness centrality (0.128) - this node is a cross-community bridge._
- **What connects `singleQuote`, `semi`, `arrowParens` to the rest of the system?**
  _333 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Immutable Repository Sources` be split into smaller, more focused modules?**
  _Cohesion score 0.05198776758409786 - nodes in this community are weakly interconnected._
- **Why does `Session` connect `Session Build State` to `Session Dashboard Components`, `Encrypted Backup Operations`, `Durable Runtime Transactions`, `Repository Discovery Budgets`, `PostgreSQL Runtime Ownership`, `PostgreSQL Session Persistence`, `Repository Tool Dispatch`, `Build Attempt Recovery`, `Publication Scope Tests`, `Compose Browser Verification`, `Shared Session Types`, `Trusted Git Workflow`, `Isolated Patch Publication`, `Session Data Retention`, `Durable Build Queue`, `Draft PR Publication`, `Build Complexity Validation`, `Build Executor Interfaces`, `Build Workflow Execution`, `Decision Spec Generation`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Should `Session Dashboard Components` be split into smaller, more focused modules?**
  _Cohesion score 0.06682692307692308 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Task Commands` to `Project Runtime Configuration`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Should `Durable Runtime Transactions` be split into smaller, more focused modules?**
  _Cohesion score 0.1028225806451613 - nodes in this community are weakly interconnected._

## Extraction coverage and limitations

- Current scan: **198 code files**, **44 documents**. Every document and all **26 Build source/test files** have source-backed graph representation.
- Eighteen changed documents were re-extracted from final text; 26 unchanged documents reused content-validated cache entries. Superseded ADRs and historical research remain labeled as historical; stale semantic nodes were removed instead of merged back.
- Upstream TypeScript parser warnings: `src/lib/security/model-budget.ts:258` (22 symbols extracted) and `tests/integration/model-gateway.test.ts:77` (13 symbols extracted). These graph parser warnings do not indicate a TypeScript compiler failure; symbol coverage in these files can be partial.
- **18 files** have only file-level AST evidence, so the graph cannot establish their full internal behavior: `eslint.config.mjs`, `playwright.config.ts`, `postcss.config.js`, `src/lib/build/index.ts`, `tests/code/resolve-code-source.test.ts`, `tests/egress-proxy.test.ts`, `tests/evals/offline.test.ts`, `tests/fixtures.test.ts`, `tests/lib/build/executor.test.ts`, `tests/lib/build/github-credentials.test.ts`, `tests/lib/complexity.test.ts`, `tests/lib/security/operator.test.ts`, `tests/lib/session/build-state-machine.test.ts`, `tests/lib/session/capability.test.ts`, `tests/lib/session/spec-builder.test.ts`, `tests/lib/singleton.test.ts`, `vitest.config.ts`, `vitest.integration.config.ts`.
- JSON data files intentionally produce no AST nodes: `.claude/settings.json`, `evals/cases/partial-profile.json`, `evals/cases/prompt-injection.json`, `evals/cases/scope-confirmation.json`, `evals/cases/scope-confirmed.json`, `evals/cases/small-build.json`.
- `migrations/003_retry_leases.sql` and `migrations/004_build_recovery.sql` have file-level representation without located symbols.
- Raw extraction contained **14 dangling-endpoint edges**. **4** InMemoryCodeSource import endpoints were normalized to the existing class ID after checking its exact re-export in `src/lib/code/index.ts:5,10`; **10** unresolved edges were omitted from export. Omitted evidence concerns generated Next.js types, the CSS import, Python dependency imports, and one `json` call target; these relationships remain unknown in this graph.
- Export input health: **0 missing-endpoint edges**, **0 dangling-endpoint edges**, **23 self-loops**, **6 exact duplicate edges**, and **155 relationships sharing an undirected endpoint pair**. The standard undirected graph collapses parallel relationships; graph navigation is evidence, not an exhaustive call graph.
- **195 external-reference edges** identify dependencies outside the extracted corpus. Upstream AST IDs also collide for three case-distinct class/instance or type/value names (`ToolRegistry`/`toolRegistry`, `ProfileLimits`/`profileLimits`, `SessionStore`/`sessionStore`). No inferred repair edges were added.
- Host semantic extraction token usage is not available from Graphify. Stored numeric token counters are accounting placeholders; **no external-provider extraction calls** were made.
