# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 11/11 scenarios passed |
| Average duration | 1.5m per scenario |

| # | Scenario | Result | Attempts | Duration | Evidence |
|---|---|---|---|---|---|
| 1 | The host loads the packed plugin and registers its tools | **PASS** | 1 | 17.3s | workflow-list ran through the host and listed the project profiles |
| 2 | Without a workflow session the plugin stays out of the way | **PASS** | 1 | 14.4s | bash ran with no workflow session and the plugin persisted nothing |
| 3 | workflow-create puts the session under the state machine | **PASS** | 1 | 15.9s | session persisted in stage planning |
| 4 | A bare git commit is refused inside a governed session | **PASS** | 1 | 30.2s | the host cancelled the tool call and surfaced the workflow reason |
| 5 | Only the orchestrator may write workflow task state | **PASS** | 2 | 28.1s | the orchestrator set the list; the worker agent was refused and the status stayed pending |
| 6 | commit-task is refused while the gates have not passed | **PASS** | 1 | 26.1s | the delivery guard refused the call and no receipt was written |
| 7 | An approved plan moves the session out of planning | **PASS** | 1 | 39.9s | consent recorded the plan reference and the guard released planning → tasks_ready |
| 8 | A commit that matches the permit is receipted | **PASS** | 1 | 56.1s | the permit was issued, the commit moved HEAD, and the receipt records that commit |
| 9 | A commit that sweeps in an unrelated file is not receipted | **PASS** | 8 | 2.7m | HEAD moved but the commit carried unrelated.txt: no receipt, permit dropped, refusal surfaced |
| 10 | Full CI/CD pipeline: init → checkout → build → test(unit+integration) → deploy → smoke → done | **PASS** | 10 | 8.0m | full CI/CD pipeline passed: init → consent → setup → build → unit → integration → deploy (consent) → smoke → done |
| 11 | A live subagent closes a gate with its own workflow-result | **PASS** | 6 | 2.4m | two live subagents each closed their own gate with a workflow-result; the stage held for the first and completed the task on the second |
