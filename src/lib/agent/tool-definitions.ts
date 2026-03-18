import { LiteralJsonSchemaPropertyType } from '@elevenlabs/elevenlabs-js/api'

// session_id is injected as a dynamic variable by the frontend when starting a conversation.
// It is passed in the body of every webhook call so route handlers can look up the session.
// dynamicVariable is an ElevenLabs-specific extension to JSON Schema — not part of the spec,
// but required for runtime variable injection into webhook tool calls.
const SESSION_ID_PROP = {
  type: LiteralJsonSchemaPropertyType.String,
  dynamicVariable: 'session_id',
} as const

// Builds the webhook tool configs for use with conversationalAi.tools.create().
// Tools are now standalone entities (not embedded in agent config) — see agent-tools-deprecation.
// appUrl is the base URL of this Next.js app (e.g. https://specvoice.example.com).
// Field names inside toolConfig use camelCase per the SDK (apiSchema, requestBodySchema),
// even though the REST API reference shows snake_case equivalents.
export function buildToolConfigs(appUrl: string) {
  return [
    {
      toolConfig: {
        type: 'webhook' as const,
        name: 'list_files',
        description:
          'List files in the repository. Use at the start of exploration or when moving to a new area. Optionally narrow to a subdirectory.',
        apiSchema: {
          url: `${appUrl}/api/tools/list-files`,
          method: 'POST',
          requestBodySchema: {
            type: 'object',
            required: ['session_id'],
            properties: {
              session_id: SESSION_ID_PROP,
              path: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'Subdirectory path to list. Omit for the repository root.',
              },
            },
          },
        },
      },
    },
    {
      toolConfig: {
        type: 'webhook' as const,
        name: 'read_file',
        description:
          'Read the contents of a file. Use before asking about any specific code area. Request specific line ranges for large files.',
        apiSchema: {
          url: `${appUrl}/api/tools/read-file`,
          method: 'POST',
          requestBodySchema: {
            type: 'object',
            required: ['session_id', 'path'],
            properties: {
              session_id: SESSION_ID_PROP,
              path: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'File path relative to the repository root.',
              },
              start_line: {
                type: LiteralJsonSchemaPropertyType.Integer,
                description: 'First line to read (1-indexed). Omit to start from the top.',
              },
              end_line: {
                type: LiteralJsonSchemaPropertyType.Integer,
                description: 'Last line to read (inclusive). Omit to read to the end.',
              },
            },
          },
        },
      },
    },
    {
      toolConfig: {
        type: 'webhook' as const,
        name: 'search_code',
        description:
          'Search for a string across the codebase. Use to find where something is defined or used, and to assess the impact of proposed changes.',
        apiSchema: {
          url: `${appUrl}/api/tools/search-code`,
          method: 'POST',
          requestBodySchema: {
            type: 'object',
            required: ['session_id', 'query'],
            properties: {
              session_id: SESSION_ID_PROP,
              query: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'Search string to look for across the codebase.',
              },
              max_results: {
                type: LiteralJsonSchemaPropertyType.Integer,
                description: 'Maximum number of results to return. Defaults to 20.',
              },
            },
          },
        },
      },
    },
    {
      toolConfig: {
        type: 'webhook' as const,
        name: 'save_decision',
        description:
          'Record an agreed technical decision. Call this every time you and the developer agree on something meaningful — do not batch at the end.',
        apiSchema: {
          url: `${appUrl}/api/tools/save-decision`,
          method: 'POST',
          requestBodySchema: {
            type: 'object',
            required: ['session_id', 'summary', 'rationale', 'alternatives_considered', 'relevant_files'],
            properties: {
              session_id: SESSION_ID_PROP,
              summary: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'What was decided.',
              },
              rationale: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'Why this choice was made.',
              },
              alternatives_considered: {
                type: 'array',
                description: 'What was rejected and why.',
                items: {
                  type: LiteralJsonSchemaPropertyType.String,
                  description: 'A rejected alternative and the reason it was not chosen.',
                },
              },
              relevant_files: {
                type: 'array',
                description: 'File paths that informed this decision.',
                items: {
                  type: LiteralJsonSchemaPropertyType.String,
                  description: 'A file path relative to the repository root.',
                },
              },
            },
          },
        },
      },
    },
    {
      toolConfig: {
        type: 'webhook' as const,
        name: 'flag_question',
        description:
          'Flag an open question that cannot be resolved on this call. Use when something comes up that needs more information or a separate decision.',
        apiSchema: {
          url: `${appUrl}/api/tools/flag-question`,
          method: 'POST',
          requestBodySchema: {
            type: 'object',
            required: ['session_id', 'question', 'context'],
            properties: {
              session_id: SESSION_ID_PROP,
              question: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'The unresolved question.',
              },
              context: {
                type: LiteralJsonSchemaPropertyType.String,
                description: 'Why this came up and what information is needed to resolve it.',
              },
            },
          },
        },
      },
    },
    {
      toolConfig: {
        type: 'webhook' as const,
        name: 'generate_spec',
        description:
          'Generate the final PR spec from all saved decisions and open questions. Call once at the end after the developer confirms the summary.',
        apiSchema: {
          url: `${appUrl}/api/tools/generate-spec`,
          method: 'POST',
          requestBodySchema: {
            type: 'object',
            required: ['session_id'],
            properties: {
              session_id: SESSION_ID_PROP,
            },
          },
        },
      },
    },
  ]
}
