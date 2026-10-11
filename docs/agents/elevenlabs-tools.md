# ElevenLabs tool names

The agent-facing tool name and the server route name intentionally use different casing conventions. Keep both sides stable.

| Agent tool name | Webhook route and registry key |
| --------------- | ------------------------------ |
| `list_files`    | `list-files`                   |
| `read_file`     | `read-file`                    |
| `search_code`   | `search-code`                  |
| `save_decision` | `save-decision`                |
| `flag_question` | `flag-question`                |
| `generate_spec` | `generate-spec`                |

The names in `src/lib/agent/tool-definitions.ts` are sent to ElevenLabs. The kebab-case names in `src/lib/api/tool-registry.ts` and `src/app/api/tools/[name]/route.ts` are server routing keys. The mapping is intentional; do not rename one side without updating the other and its tests.
