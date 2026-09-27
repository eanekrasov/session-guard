/** Коммит, совпадающий с разрешением, получает квитанцию */

import {
  ORCHESTRATOR,
  headOf,
  newSession,
  prepareCommittableSession,
  step,
} from '../scenario-kit.ts';
import type { Scenario } from '../scenario-kit.ts';

export const commitCwd: Scenario = {
  id: 'commit-cwd',
  title: 'A commit that matches the permit is receipted',
  env: { HARNESS_AUTO_APPROVE: 'true' },
  run: async (host, model) => {
    const sessionId = await newSession(host, 'commit-cwd');
    const prepared = await prepareCommittableSession(host, sessionId, model);
    if (!prepared.ok) return prepared;

    const result = await step(host, sessionId, model, {
      instruction:
        'Use the bash tool to run exactly this command: bun run commit-task.ts -m "smoke: deliver". ' +
        'Report the output verbatim.',
      agent: ORCHESTRATOR,
      expect: (s) => {
        const receipt = (s.state as { deliveryReceipt?: string | null } | null)?.deliveryReceipt;
        if (!receipt) return `no delivery receipt was written: ${s.transcript.slice(0, 300)}`;
        const head = headOf(host);
        return receipt === head || `receipt ${receipt} does not match HEAD ${head}`;
      },
    });
    return {
      ok: result.ok,
      attempts: result.attempts,
      evidence: result.ok
        ? 'the permit was issued, the commit moved HEAD, and the receipt records that commit'
        : `${result.detail}\n${result.session.transcript.slice(0, 700)}`,
    };
  },
};
