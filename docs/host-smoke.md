# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 8/12 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | The host loads the packed plugin and registers its tools | **PASS** | 1 | workflow.list ran through the host and listed the project profiles |
| 2 | Without a workflow session the plugin stays out of the way | **PASS** | 1 | bash ran with no workflow session and the plugin persisted nothing |
| 3 | workflow.create puts the session under the state machine | **PASS** | 1 | session persisted in stage planning |
| 4 | A bare git commit is refused inside a governed session | **PASS** | 1 | the host cancelled the tool call and surfaced the workflow reason |
| 5 | Only the orchestrator may write workflow task state | **PASS** | 2 | the orchestrator set the list; the worker agent was refused and the status stayed pending |
| 6 | commit-task is refused while the gates have not passed | **PASS** | 1 | canCommit refused the call and no receipt was written |
| 7 | An approved plan moves the session out of planning | **PASS** | 1 | consent recorded the plan reference and the guard released planning → tasks_ready |
| 8 | A commit that matches the permit is receipted | **FAIL** | 0 | harness error: spawnSync is not defined CsLG/work git=/var/folders/0s/43r2yvkd14b6qxbcsn3gkg0r0000gp/T/host-smoke-ENCsLG/home/data/opencode/snapshot/0cb2031fd686dde72d5062a710d70f631a467753/93876d75848d2326dab98ae57b86ca0147ffdff0 timestamp=2026-09-06T15:10:45.761Z level=INFO run=7022c635 message="S |
| 9 | A commit that sweeps in an unrelated file is not receipted | **FAIL** | 0 | harness error: spawnSync is not defined ujaf/work git=/var/folders/0s/43r2yvkd14b6qxbcsn3gkg0r0000gp/T/host-smoke-2cujaf/home/data/opencode/snapshot/33c9e956c72cf81315f93de796ed6d1d2f0f9a7d/538f9cc033ef9ff7e380ae3fb4be4564ad63680a timestamp=2026-09-06T15:11:10.269Z level=INFO run=8b296a28 message="S |
| 10 | Full cycle through the comprehensive profile — entryGuards, exitGuards, gates, fail/retry, alternative transitions, commit receipt | **FAIL** | 6 | the task is at mutation      The coder agent refuses with the same error: "Stage mutation is not declared by stage execution." This appears to be a systemic restriction on the coder subagent type in this session — it won't execute the task.  However, I have personally verified the file content using |
| 11 | Full CI/CD pipeline: init → checkout → build → test(unit+integration) → deploy → smoke → done | **FAIL** | 6 | stage is checkout, expected test      The builder agent has confirmed that `src/ci-demo.ts` compiles successfully with no errors and returned the expected workflow result.        |
| 12 | A live subagent closes a gate with its own workflow-result | **PASS** | 6 | two live subagents each closed their own gate with a workflow-result; the stage held for the first and completed the task on the second |
