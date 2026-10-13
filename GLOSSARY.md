# SpecVoice

SpecVoice turns a codebase conversation into a reviewable implementation proposal and, after the call, an optional generated change.

## Conversation and planning

**Session**:
A bounded engineering conversation and the evidence it produces for one repository change.
A saved Session can contain successive private voice calls and survive login expiry or browser reloads.
_Avoid_: Call, job, run

**Decision**:
An agreement that narrows the intended change, including its rationale and meaningful alternatives.
_Avoid_: Note, preference, prompt

**Open question**:
An unresolved issue whose answer is needed before a safe implementation proposal can be accepted.
_Avoid_: TODO, blocker

**Spec**:
The structured implementation proposal produced from the decisions and evidence in a session.
_Avoid_: Prompt, plan, ticket

## Execution

**Tool webhook**:
A named boundary through which the voice agent inspects repository code or records session information.
_Avoid_: Function, endpoint (when referring to the agent-facing capability)

**Complexity gate**:
A readiness assessment that decides whether a spec is sufficiently bounded for automated execution.
_Avoid_: Estimate, approval

**Build**:
The post-call execution of a spec that produces a proposed repository change for human review.
_Avoid_: Deploy, release

**Graphify**:
The optional repository knowledge graph used to trace relationships and identify likely impact and linked tests; source code and tests remain the authority.
_Avoid_: Source of truth, code generator

## Security and execution

**Session capability**:
A short-lived signed credential bound to one Session call and accepted by voice tool webhooks. Operator cookies authorize dashboard access and Builds separately.
_Avoid_: Session ID, API key

**Repository root**:
The directory boundary that contains the local files a Session may inspect.
_Avoid_: Working directory, filesystem root

**Build Attempt**:
One idempotent request to turn a completed Spec into a reviewable repository change. It freezes the commit, scope, generation inputs, and unique branch identity; checkpoints distinguish generation from publication recovery.
_Avoid_: Build job, deploy

**Repository Snapshot**:
The immutable repository state, identified by a commit, that a Session inspects and a Build uses.
_Avoid_: Latest repository, working tree

**Repository Profile**:
The bounded inventory for a Repository Snapshot: commit, file and byte counts, package manifests, language counts, generated/vendor roots, tier, and index status. Partial counts are lower bounds and always require confirmed scope.
_Avoid_: Full index, repository scan

**Scope Plan**:
The explicitly confirmed literal file/directory roots and exclusions tied to a Repository Snapshot. Confirmation uses server-inventoried counts; saved edits require confirmation again. Discovery is budgeted before confirmation, and accepted Builds freeze the plan.
_Avoid_: Full repository, estimate

**Webhook receipt**:
The durable identity and processing record for one signed provider delivery, used to make retries idempotent.
_Avoid_: Webhook request, transcript

**Offline evaluation case**:
A secret-free fixture that checks deterministic tool, safety, evidence, and scope contracts without calling a live provider.
_Avoid_: Benchmark, live score

**Egress proxy**:
The local network boundary through which a Worker or disposable execution reaches explicitly allowed GitHub and package-registry hosts. Model requests use the separate model gateway.
_Avoid_: Internet access, firewall

**Worker**:
A trusted orchestration process with independent Build, profiling, receipt and maintenance lanes outside web requests. It owns publication; repository commands run in disposable execution containers.
_Avoid_: Server, agent

**Voice call**:
One private provider conversation with its own identity, deadline, capability and signed completion, linked to a saved Session.

**Execution launcher**:
The restricted local interface that owns the Docker socket and starts only the fixed execution image with configured limits.

**Model gateway**:
The local interface that holds the real model key, verifies attempt ownership, reserves estimated spending and records usage.

**Restore drill**:
A restore into disposable PostgreSQL storage that checks backup integrity, retention and preserved Session/event identity without replacing the application database.
