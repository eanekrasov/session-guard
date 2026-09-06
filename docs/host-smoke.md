# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 1/1 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | The host loads the packed plugin and registers its tools | **PASS** | 1 | workflow.list ran through the host and listed the project profiles |
