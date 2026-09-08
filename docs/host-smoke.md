# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 10/11 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | The host loads the packed plugin and registers its tools | **PASS** | 1 | workflow.list ran through the host and listed the project profiles |
| 2 | Without a workflow session the plugin stays out of the way | **PASS** | 1 | bash ran with no workflow session and the plugin persisted nothing |
| 3 | workflow.create puts the session under the state machine | **PASS** | 1 | session persisted in stage planning |
| 4 | A bare git commit is refused inside a governed session | **PASS** | 1 | the host cancelled the tool call and surfaced the workflow reason |
| 5 | Only the orchestrator may write workflow task state | **FAIL** | 0 | harness error: The operation timed out. or mode=primary timestamp=2026-09-08T04:22:49.948Z level=INFO run=af68ca2d message="llm runtime selected" llm.runtime=ai-sdk llm.provider=crpt llm.model=deepseek-ai/DeepSeek-V4-Flash-small timestamp=2026-09-08T04:22:49.961Z level=INFO run=af68ca2d message="Ses |
| 6 | commit-task is refused while the gates have not passed | **PASS** | 1 | the delivery guard refused the call and no receipt was written |
| 7 | An approved plan moves the session out of planning | **PASS** | 1 | consent recorded the plan reference and the guard released planning → tasks_ready |
| 8 | A commit that matches the permit is receipted | **PASS** | 1 | the permit was issued, the commit moved HEAD, and the receipt records that commit |
| 9 | A commit that sweeps in an unrelated file is not receipted | **PASS** | 9 | HEAD moved but the commit carried unrelated.txt: no receipt, permit dropped, refusal surfaced |
| 10 | Full CI/CD pipeline: init → checkout → build → test(unit+integration) → deploy → smoke → done | **PASS** | 10 | full CI/CD pipeline passed: init → consent → setup → build → unit → integration → deploy (consent) → smoke → done |
| 11 | A live subagent closes a gate with its own workflow-result | **PASS** | 6 | two live subagents each closed their own gate with a workflow-result; the stage held for the first and completed the task on the second |
