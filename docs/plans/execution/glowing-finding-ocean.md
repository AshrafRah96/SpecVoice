# Plan: Fill in evaluation and dataCollection in config.ts

## Context

The ElevenLabs agent enrichment is complete and all tests pass. Two `platformSettings` fields
remain as empty objects with TODO comments in `src/lib/agent/config.ts`:
- `evaluation: {}` — needs 3 `PromptEvaluationCriteria` entries
- `dataCollection: {}` — needs 5 `LiteralJsonSchemaProperty` fields

Both SDK types are now confirmed from `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/`.

---

## Change: `src/lib/agent/config.ts`

**Add import** (alongside existing imports from `@elevenlabs/elevenlabs-js/api`):
```ts
LiteralJsonSchemaPropertyType,
```

**Replace `evaluation: {}`** with:
```ts
evaluation: {
  criteria: [
    {
      id: 'spec_generated',
      name: 'Spec Generated',
      conversationGoalPrompt: 'The conversation produced a complete PR spec.',
    },
    {
      id: 'assumptions_challenged',
      name: 'Assumptions Challenged',
      conversationGoalPrompt: 'The agent pushed back on at least one assumption.',
    },
    {
      id: 'code_grounded',
      name: 'Code Grounded',
      conversationGoalPrompt: 'The agent cited actual files or patterns from the codebase.',
    },
  ],
},
```

**Replace `dataCollection: {}`** with:
```ts
dataCollection: {
  feature_name: {
    type: LiteralJsonSchemaPropertyType.String,
    description: 'The name of the feature being specced.',
  },
  decisions_count: {
    type: LiteralJsonSchemaPropertyType.Integer,
    description: 'Number of architectural decisions recorded.',
  },
  open_questions_count: {
    type: LiteralJsonSchemaPropertyType.Integer,
    description: 'Number of open questions flagged.',
  },
  files_explored: {
    type: LiteralJsonSchemaPropertyType.Integer,
    description: 'Number of files the agent read during the call.',
  },
  conversation_outcome: {
    type: LiteralJsonSchemaPropertyType.String,
    description: 'One of: spec_completed, abandoned, needs_followup.',
  },
},
```

---

## Critical Files

| File | Action |
|------|--------|
| [src/lib/agent/config.ts](src/lib/agent/config.ts) | Add `LiteralJsonSchemaPropertyType` import; fill in `evaluation.criteria` and `dataCollection` |

---

## Verification

```bash
npm run build   # zero TypeScript errors
npm test        # all tests still pass
```
