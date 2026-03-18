# ElevenLabs SDK — Undocumented Behavior & Workarounds

Gaps discovered while building the SpecVoice test suite. Not bugs, just things the docs don't tell you.

---

## 1. `checkAnyToolMatches: true` expects zero tool calls without `toolCallParameters`

You write a unit test with `type: 'tool'`, `checkAnyToolMatches: true`, and no `toolCallParameters`. The agent correctly calls a tool. The test fails with `"Expected 0 tool calls, received 1"`.

The flag means "pass if any tool call matches the criteria in `toolCallParameters`." Without `toolCallParameters`, there are no criteria — so the vacuous match is zero tool calls. The docs describe this as "pass if any tool call matches the criteria" which sounds like it means any tool call at all. It doesn't.

**Fix:** Use `type: 'llm'` with a `successCondition` that describes the expected tool behaviour. The evaluator sees the full agent turn including tool calls, so you get the same coverage. Or, if you specifically need tool-call testing, populate `toolCallParameters.referencedTool` with the tool's workspace ID from `client.conversationalAi.tools.list()`.

**References:**
- [Agent Testing guide](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing) — describes tool call testing but does not explain the `checkAnyToolMatches` / `toolCallParameters` relationship or the vacuous match behavior.
- [Create test API reference](https://elevenlabs.io/docs/api-reference/tests/create) — shows the request schema but the `tool` variant fields are behind a JS-rendered panel that doesn't expand statically.
- [Changelog, Feb 2 2026](https://elevenlabs.io/docs/changelog/2026/2/2) — confirms `check_any_tool_matches` was added to "relax tool call matching requirements" but gives no elaboration on what happens when `toolCallParameters` is absent.

---

## 2. Unit tests require `dynamicVariables` even when they don't call tools

Every unit test fails with `"Missing required dynamic variables in tools: {'session_id'}"` even though your test has nothing to do with tools.

ElevenLabs validates that every dynamic variable declared anywhere in the agent's tool schemas is supplied before running a test. That validation fires regardless of test type — a pure `type: 'llm'` test that never touches a tool still has to pass it.

The `dynamicVariables` field does exist in the type definitions for both `CreateToolCallUnitTestRequest` and `CreateResponseUnitTestRequest`, but nothing in the docs flags it as required or explains when validation runs.

**Fix:** Add `dynamicVariables: { session_id: 'unit-test-session' }` to every unit test spec. A dummy string value is fine — it just needs to be present.

**References:**
- [Agent Testing guide](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing) — mentions configuring dynamic variables for tool call tests in the context of matching production values. Does not state that `dynamicVariables` is required for all test types regardless of tool usage.
- [Dynamic variables guide](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables) — documents the `{{var_name}}` syntax and runtime injection mechanism but says nothing about test-time validation behavior.
- [Create test API reference](https://elevenlabs.io/docs/api-reference/tests/create) — `dynamicVariables` appears in the type definitions but is not documented as required or explained.

---

## 3. `type: 'llm'` tests evaluate the full agent turn, tool calls included

A `type: 'llm'` test's `successCondition` fails because the evaluator can see tool calls made during the turn, not just the text response.

When the agent calls a tool, the evaluator sees the tool call as part of the response. A condition like "do not produce implementation steps" will fail if the agent calls `list_files` mid-turn, even if the text response looks fine. The docs describe `type: 'llm'` as evaluating the text response. Tool call visibility in the evaluator isn't mentioned.

**Upside:** You can lean into this. Reference tool calls explicitly in `successCondition` and `failureExamples` — for example, `"[calls list_files]"` as a failure example. The LLM evaluator understands them.

**References:**
- [Agent Testing guide](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing) — describes scenario testing as evaluating "the agent's response" and "conversational abilities". Makes no mention of tool calls being visible to the evaluator.
- [Simulate Conversations guide](https://elevenlabs.io/docs/agents-platform/guides/simulate-conversations) — covers the simulation API but does not describe evaluator scope relative to tool calls made during a turn.

---

## 4. Array items in `requestBodySchema` require a value-source field

You define an array parameter with `{ type: 'string' }` items and get HTTP 400: `"Must set one of: description, dynamic_variable, is_system_provided, or constant_value"`.

Every `LiteralJsonSchemaProperty` — including those used as array `items` — must have exactly one of `description`, `dynamicVariable`, `isSystemProvided`, or `constantValue` set. A bare `{ type: 'string' }` is rejected. The constraint exists in the type docs but isn't flagged for nested items.

**Fix:** Always add a `description` to array items:

```typescript
items: {
  type: LiteralJsonSchemaPropertyType.String,
  description: 'A rejected alternative and the reason it was not chosen.',
}
```

**References:**
- [Create agent API reference](https://elevenlabs.io/docs/api-reference/agents/create) — tool schema configuration is behind JS-rendered "Show properties" panels and not accessible in a static fetch. The `LiteralJsonSchemaProperty` constraint is not surfaced in readable documentation.
- [Server tools guide](https://elevenlabs.io/docs/agents-platform/customization/tools/server-tools) — describes body parameters for webhook tools at a conceptual level. No code example for the programmatic API, and no documentation of the value-source requirement.
- Source of truth: `LiteralJsonSchemaProperty` type in `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/`.

---

## 5. The agent ignores explicit guardrails when chat history shows no prior exploration

Your system prompt says to call `generate_spec` when the user says "write it up". The agent calls `list_files` instead.

When the conversation history contains no prior tool calls, the agent infers it hasn't explored the codebase yet. It prioritises "orient in the relevant area" over "wrap up", overriding the explicit guardrail based on inferred state. No documentation covers how conversation history affects system prompt rule priority.

**Fix:** Unit test `chatHistory` for wrap-up scenarios must include at least one prior tool call with a plausible result to signal that exploration has already happened. Without it, the agent will explore before generating the spec regardless of what the system prompt says.

**References:**
- [Prompting guide](https://elevenlabs.io/docs/agents-platform/best-practices/prompting-guide) — covers system prompt structure and tool orchestration best practices but does not address how chat history state influences rule priority or guardrail overriding.
- [Agent Testing guide](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing) — documents `chatHistory` as a field for setting up test scenarios but does not explain its effect on agent state inference.
- No documentation for this behavior exists. Discovered through live call iteration and test suite debugging.

---

## 6. `simulateConversation` requires `dynamicVariables` for all agent tool dynamic variables

Simulation fails with HTTP 400 `"Missing required dynamic variables: {'session_id'}"`.

Same validation as issue #2. `simulationSpecification.dynamicVariables` must supply every dynamic variable declared in agent tools. Also worth setting `toolMockConfig` for all webhook tools — otherwise the simulation will attempt to call real localhost endpoints.

**Fix:** Pass both inside `simulationSpecification`:

```typescript
simulationSpecification: {
  dynamicVariables: { session_id: 'sim-session-001' },
  toolMockConfig: {
    list_files: {
      defaultReturnValue: JSON.stringify({ files: [...] })
    },
    // all other tools
  },
}
```

**References:**
- [Simulate Conversations guide](https://elevenlabs.io/docs/agents-platform/guides/simulate-conversations) — mentions `tool_mock_config` and `dynamic_variables` as available parameters and points to the API reference for a full list. Does not state that `dynamicVariables` is required or explain what triggers the validation error.
- [Simulate conversation API reference](https://elevenlabs.io/docs/api-reference/agents/simulate-conversation) — `simulationSpecification` fields are behind a JS-rendered panel and not accessible in a static fetch.

---

## 7. camelCase vs snake_case is never documented together

The REST API reference uses `snake_case` throughout. The `@elevenlabs/elevenlabs-js` SDK uses `camelCase` throughout. These are not cross-referenced anywhere — no getting started page, no SDK readme section, no callout in the agent config guide.

The practical consequence is that code written from the REST docs compiles fine but silently does nothing. The SDK accepts loose object shapes in several places, so passing `model_id` instead of `modelId` produces no type error and no runtime error — the field is just ignored.

**Fix:** Always write agent config from the TypeScript types, not from the REST reference. If you're unsure of a field name, check the `.d.ts` files or run your editor's autocomplete against the typed request object. Never copy field names from the API reference into SDK calls.

**References:**
- [Create agent API reference](https://elevenlabs.io/docs/api-reference/agents/create) — uses `snake_case` throughout (e.g. `conversation_config`, `model_id`, `voice_id`). No note that the JS SDK uses different casing.
- [SDK README on GitHub](https://github.com/elevenlabs/elevenlabs-js) — shows `camelCase` in code examples (e.g. `modelId`) but never explicitly states that this differs from the REST reference or explains what happens if you use the wrong casing.
- [npm package page](https://www.npmjs.com/package/@elevenlabs/elevenlabs-js) — same omission. Neither page cross-references the other.

---

## 8. Agent config types are only discoverable by reading generated source files

`agents.create()` and `agents.update()` accept a complex nested payload. None of that shape is documented as a TypeScript interface with JSDoc in the public docs. The types exist — they live in `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/` — but finding them requires knowing to look there.

The SDK readme confirms that types are exported under the `ElevenLabs` namespace (e.g. `ElevenLabs.AgentConfig`), but doesn't enumerate what those types are or link to any reference. There is no "full typed config example" in the docs.

**Fix:** Before writing any agent config code, open the generated types directly. Search for `AgentConfig`, `ConversationConfig`, and `PromptAgent` in the dist folder to find the full shape. Your IDE's go-to-definition on any SDK method is the fastest path.

**References:**
- [Create agent API reference](https://elevenlabs.io/docs/api-reference/agents/create) — request body is described at a high level with expandable panels requiring a logged-in browser session. No TypeScript interface is shown.
- [SDK README on GitHub](https://github.com/elevenlabs/elevenlabs-js) — confirms types are exported under `ElevenLabs.*` but lists only a handful of example types (`Voice`, `Model`) and links to no type reference for agent configuration.
- [npm package page](https://www.npmjs.com/package/@elevenlabs/elevenlabs-js) — same as README. No enumeration of agent config types or link to a generated type reference.

---

## 9. Injecting a dynamic variable into a tool parameter schema requires an undocumented SDK field

To pass `session_id` (or any conversation variable) into a webhook tool call at runtime, the property schema for that parameter needs a `dynamicVariable` field set to the variable name. This is the SDK-level mechanism — it is not part of the JSON Schema spec and it is not shown in the server tools guide or the dynamic variables guide.

The dynamic variables feature itself is documented — you can use `{{session_id}}` in prompts and headers. What's missing is the explanation that tool *parameter schemas* need `dynamicVariable` set on the relevant `LiteralJsonSchemaProperty` to wire the variable through to the request body at call time.

**Fix:** On any tool parameter that should be populated from a conversation variable, add:

```typescript
{
  type: LiteralJsonSchemaPropertyType.String,
  dynamicVariable: 'session_id',
}
```

Without this, the parameter either gets a hardcoded static value or silently fails validation.

**References:**
- [Dynamic variables guide](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables) — documents `{{var_name}}` syntax for prompts, first messages, and tool headers. Does not mention `dynamicVariable` as a field on tool parameter schemas.
- [Server tools guide](https://elevenlabs.io/docs/agents-platform/customization/tools/server-tools) — covers webhook tool configuration including body parameters and dynamic variable assignment in responses, but never shows the `dynamicVariable` field on an input parameter schema.
- Source of truth: `LiteralJsonSchemaProperty` type in `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/`.

---

*All of the above were found through trial, error, and reading source. None are in the official docs.*