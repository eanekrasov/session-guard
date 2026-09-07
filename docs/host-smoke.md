# Host smoke — session-guard against a real opencode

| Model | `crpt/deepseek-ai/DeepSeek-V4-Flash-small` |
|---|---|
| Plugin | `dist` |
| Result | 0/1 scenarios passed |

| # | Scenario | Result | Attempts | Evidence |
|---|---|---|---|---|
| 1 | The host loads the packed plugin and registers its tools | **FAIL** | 0 | harness error: POST /session/ses_f86108d60ffeUm6HihLp6Pb6z0/message → 500: {"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_1b3327de"}} ase/agents" timestamp=2026-09-07T03:35:30.995Z level=ERROR run=db02b9de message="share subscriber faile |
