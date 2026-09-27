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

/** V1-сценарии в том порядке, в котором их нумерует отчёт. */
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
  // `comprehensive-full-cycle` удалён отсюда 2026-09-07: профиль, которым он управляет,
  // ещё дописывается, поэтому сценарий сообщал о таймауте, а не о чём-то, связанном с
  // плагином. Его профиль остаётся в `profile/comprehensive/` для того, кто его закончит.
  cicdFullCycle,
  verifyLoop,
];

/**
 * V2-сценарии в порядке, в котором их выводит отчёт прогона. Объявлены как шаги и выполняются
 * через `runV2Scenario`; V1-сценарии императивны, поэтому списки раздельные, а не один.
 */
export const v2Scenarios: V2Scenario[] = [v2WorkflowCreate, v2WorkflowConsent, v2WorkflowTasks];
