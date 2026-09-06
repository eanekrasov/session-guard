# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 1/2 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | A commit that matches the permit is receipted | **FAIL** | 3 | no delivery receipt was written:      The command output is:  ``` commit-task: nothing staged to commit ```             The command output is:  ``` commit-task: nothing staged to commit ```        |
| 2 | A commit that sweeps in an unrelated file is not receipted | **PASS** | 6 | HEAD moved but the commit carried unrelated.txt: no receipt, permit dropped, refusal surfaced |
