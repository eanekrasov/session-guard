# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 0/1 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | A live subagent closes a gate with its own workflow-result | **FAIL** | 7 | the review gate is (unset)      The reviewer agent continues to respond with the same message. This appears to be a persistent system-level restriction on the reviewer subagent for the "smoke" profile. I cannot override this behavior.        |
