import type { Scenario } from '../scenario-kit.ts';

import { cicdFullCycle } from './cicd-full-cycle.ts';
import { commitCwd } from './commit-cwd.ts';
import { commitGate } from './commit-gate.ts';
import { commitMismatch } from './commit-mismatch.ts';
import { create } from './create.ts';
import { gitBlock } from './git-block.ts';
import { noSession } from './no-session.ts';
import { planConsent } from './plan-consent.ts';
import { pluginLoads } from './plugin-loads.ts';
import { taskControl } from './task-control.ts';
import { verifyLoop } from './verify-loop.ts';

/** The V1 scenarios, in the order the report numbers them. */
export const scenarios: Scenario[] = [
  pluginLoads,
  noSession,
  create,
  gitBlock,
  taskControl,
  commitGate,
  planConsent,
  commitCwd,
  commitMismatch,
  // `comprehensive-full-cycle` was removed here on 2026-09-07: the profile it
  // drives is still being written, so the scenario reported a timeout rather
  // than anything about the plugin. Its profile stays under
  // `profile/comprehensive/` for whoever finishes it.
  cicdFullCycle,
  verifyLoop,
];
