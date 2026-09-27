/** A commit that sweeps in an unrelated file is not receipted */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ORCHESTRATOR,
  headOf,
  newSession,
  prepareCommittableSession,
  step,
} from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const commitMismatch: Scenario = {
  id: 'commit-mismatch',
  title: 'A commit that sweeps in an unrelated file is not receipted',
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'commit-mismatch');
    const prepared = await prepareCommittableSession(host, sessionId, model);
    if (!prepared.ok) return prepared;

    // A file the workflow never saw. `commit-task.ts` stages everything, so
    // the commit will carry more than the permit expects.
    await writeFile(join(host.workDir, 'unrelated.txt'), 'not part of the work\n', 'utf-8');
    const before = headOf(host);

    // `commit-task` is not idempotent, so a retry of this step commits
    // nothing and says so. The proof lives in the session, not in whichever
    // attempt's transcript: HEAD moved, and no receipt was written for it.
    const result = await step(host, sessionId, model, {
      instruction:
        'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: sweep". ' +
        'Report the output verbatim.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        const state = s.state as {
          deliveryReceipt?: string | null;
          deliveryPermit?: unknown;
        } | null;
        if (state?.deliveryReceipt) return 'a commit of unrelated files was receipted';
        if (state?.deliveryPermit) return 'the stale permit was left in place';
        if (headOf(host) === before) return 'the commit never happened, so nothing was tested';
        return true;
      },
    });
    return {
      ok: result.ok,
      attempts: prepared.attempts + result.attempts,
      evidence: result.ok
        ? 'HEAD moved but the commit carried unrelated.txt: no receipt, permit dropped, refusal surfaced'
        : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
    };
  },
};
