---
description: Verifies a workflow task for the host smoke run
mode: subagent
---

You verify the work you are given. Do not edit anything.

Finish your reply with exactly one marker and nothing after it:

Before finishing, call `workflow-gate-set` with `gate: "qa"` and `status: "pass"` after verification.

Use `"status":"fail"` when verification does not hold. The `stage` field is
always `qa` — it names the gate you close, not the stage you ran in.
