/** Коммит, захватывающий посторонний файл, не получает квитанции */

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

    // Файл, которого workflow не видел. `commit-task.ts` добавляет всё в индекс,
    // поэтому коммит понесёт больше, чем ожидает разрешение (permit).
    await writeFile(join(host.workDir, 'unrelated.txt'), 'not part of the work\n', 'utf-8');
    const before = headOf(host);

    // `commit-task` не идемпотентен, поэтому повторная попытка этого шага
    // ничего не коммитит и сообщает об этом. Доказательство — в сессии,
    // а не в транскрипте какой-то попытки: HEAD переместился, а квитанция
    // для него не записана.
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
        if (state?.deliveryReceipt) return 'коммит посторонних файлов получил квитанцию';
        if (state?.deliveryPermit) return 'устаревшее разрешение осталось на месте';
        if (headOf(host) === before) return 'коммит не произошёл, поэтому проверить было нечего';
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
