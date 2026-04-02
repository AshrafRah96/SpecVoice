import {
  TtsConversationalModel,
  TurnEagerness,
  ClientEvent,
  Llm,
  LiteralJsonSchemaPropertyType,
} from '@elevenlabs/elevenlabs-js/api'
import { systemPrompt } from '@/lib/agent/system-prompt'

// Builds the ElevenLabs agent creation/update payload.
// Field names and types sourced from @elevenlabs/elevenlabs-js SDK — not from REST API docs,
// which use snake_case while the SDK uses camelCase throughout.
// toolIds: IDs of standalone tools created via conversationalAi.tools.create() — see setup-agent.ts.
// Tools are no longer embedded in the agent config (prompt.tools removed July 23, 2025).
export function buildAgentConfig(appUrl: string, toolIds: string[]) {
  return {
    name: 'SpecVoice Agent',
    conversationConfig: {
      agent: {
        // Greets the developer and signals it has repo access before diving in.
        firstMessage:
          "Alright, I've got access to the repo. Give me a moment to look around, then tell me what we're building.",
        language: 'en',
        prompt: {
          prompt: systemPrompt,
          // Claude is the LLM backend — configured in ElevenLabs, never called directly.
          llm: Llm.ClaudeSonnet45,
          // toolIds references standalone tools. Omitting or passing [] silently removes all tools.
          // Always pass the full list — this is a replacement, not a merge.
          toolIds,
        },
      },
      tts: {
        // Daniel (onwK4e9ZLuTAKqWW03F9): direct, authoritative senior engineer persona.
        voiceId: 'onwK4e9ZLuTAKqWW03F9',
        modelId: TtsConversationalModel.ElevenFlashV2,
        // Stability 0.7: consistent delivery across long technical explanations without
        // sounding robotic. Lower allows emotional range; higher causes monotony.
        stability: 0.7,
        similarityBoost: 0.8,
        // Speed 0.95: slightly below default — sounds deliberate, not rushed.
        speed: 0.95,
      },
      conversation: {
        // Enable live transcript events so the dashboard can display the conversation in real time.
        clientEvents: [ClientEvent.Audio, ClientEvent.AgentResponse, ClientEvent.UserTranscript],
      },
      turn: {
        // 4-second timeout: developers pause mid-thought on phone calls to work through a
        // technical problem. TurnConfig.turnTimeout is in seconds (range 1–30).
        turnTimeout: 4,
        // Patient = waits for higher turn-end probability before responding.
        // Prevents the agent from cutting off a developer who's mid-explanation.
        turnEagerness: TurnEagerness.Patient,
      },
    },
    platformSettings: {
      // ElevenLabs analytics: post-call scores feed prompt iteration dashboard.
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
      // Structured call metadata — queryable in ElevenLabs analytics.
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

      // Post-call webhook URL is configured in the ElevenLabs dashboard (not via the create API).
      // Setup script prints the URL and instructions after agent creation.
    },
  }
}

// Returns the post-call webhook URL for a given app base URL.
// Used by the setup script to print dashboard configuration instructions.
export function getPostCallWebhookUrl(appUrl: string): string {
  return `${appUrl}/api/agent/post-call`
}
