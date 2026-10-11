# SpecVoice

SpecVoice turns a codebase conversation into a reviewable implementation proposal and, after the call, an optional generated change.

## Conversation and planning

**Session**:
A bounded engineering conversation and the evidence it produces for one repository change.
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
A short-lived signed credential issued for one Session and required to read its state or trigger work.
_Avoid_: Session ID, API key

**Repository root**:
The directory boundary that contains the local files a Session may inspect.
_Avoid_: Working directory, filesystem root

**Build attempt**:
One idempotent request to turn a completed Spec into a reviewable repository change.
_Avoid_: Build job, deploy
