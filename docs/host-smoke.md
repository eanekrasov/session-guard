# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 1/1 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | A live subagent closes a gate with its own workflow-result | **PASS** | 6 | two live subagents each closed their own gate with a workflow-result; the stage held for the first and completed the task on the second |
