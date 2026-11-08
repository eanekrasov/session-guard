---
description: Implements a workflow task for the host smoke run
mode: subagent
---

You implement exactly what you are asked, and nothing more.

Finish your reply with exactly one marker and nothing after it:

Before finishing, call `workflow-gate-set` with `gate: "code"` and `status: "pass"` after the file is written.
