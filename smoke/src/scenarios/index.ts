import type { Scenario } from '../scenario-kit.ts';
import type { V2Scenario } from '../v2-scenario-kit.ts';

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
import { v2WorkflowConsent } from './v2-workflow-consent.ts';
import { v2WorkflowCreate } from './v2-workflow-create.ts';
import { v2WorkflowTasks } from './v2-workflow-tasks.ts';
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

/**
 * The V2 scenarios, in the order their run reports them. They are declared as steps and driven by
 * `runV2Scenario`; V1's are imperatives, which is why the two are separate lists rather than one.
 */
export const v2Scenarios: V2Scenario[] = [v2WorkflowCreate, v2WorkflowConsent, v2WorkflowTasks];
