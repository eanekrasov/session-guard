import type { WorkflowSession, LoopRun, MutationTask } from '../session/session-schema.ts';
import { SessionExecutor } from './session-executor.ts';
import { MutationOrchestrator } from './mutation-orchestrator.ts';
import type { LogFn } from './logger.ts';
import { type Reporter } from './report.ts';
import { agentIsAllowed } from './agent-names.ts';
import { resolveConfig } from '../public-api.ts';
import { firstNestedStageId, nestedStages, type StageDef } from '../schema/types.ts';
import {
  findTask,
  isOpenLoopRun,
  nextLoopRunId,
  upsertActiveTaskContext,
} from '../session/helpers.ts';
import { toGuardContext } from '../domain/engine.ts';
import { scopesIntersect } from './scope-match.ts';
import { captureBaseline } from './change-scope.ts';
import { WorkflowBlockedError } from './blocked-error.ts';
import type { TaskToolArgs } from './tool-args.ts';

export interface TaskAdmissionInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  output: { args: unknown };
  session: WorkflowSession;
}

export interface TaskAdmission {
  isWorkflowTask(tool: string, args: unknown): boolean;
  before(input: TaskAdmissionInput): Promise<void>;
}

export interface TaskAdmissionPorts {
  mutationOrchestrator: MutationOrchestrator;
  executor: SessionExecutor;
  sessionContext: { load: (sessionID: string) => Promise<WorkflowSession | null> };
  profilesDir: string;
  projectDir: string;
  log: LogFn;
  report: Reporter;
}

function isWorkflowTaskDescription(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  return /^\[workflow-task:(task-[0-9]+)](?:\s|$)/.exec(description)?.[1] ?? null;
}

function blockTaskAdmission(reason: string): never {
  throw new WorkflowBlockedError(reason);
}

export class TaskAdmissionImpl implements TaskAdmission {
  private readonly ports: TaskAdmissionPorts;

  constructor(ports: TaskAdmissionPorts) {
    this.ports = ports;
  }

  isWorkflowTask(tool: string, args: unknown): boolean {
    if (tool !== 'task' || !args || typeof args !== 'object') return false;
    const taskArgs = args as TaskToolArgs;
    return isWorkflowTaskDescription(taskArgs.description) !== null;
  }

  async before(input: TaskAdmissionInput): Promise<void> {
    const { sessionID, callID, args } = input;
    const taskArgs = args as TaskToolArgs;
    const agent = taskArgs.subagent_type ?? taskArgs.agent ?? taskArgs.type;
    const description = taskArgs.description;
    const match =
      typeof description === 'string'
        ? /^\[workflow-task:(task-[0-9]+)](?:\s|$)/.exec(description)
        : null;

    // match гарантированно не null — проверка уже в isWorkflowTask
    const taskId = match![1];

    // Захвачено до допуска (D2): это реальный I/O (git status + хеш на каждый
    // грязный путь) который не должен запускаться внутри сериализованной очереди
    // сессии. Отказ в допуске тратит один снимок — редкий путь.
    const frame = await this.safeCaptureBaseline();

    await this.ports.executor.run(sessionID, async (tx) => {
      if (!tx.session) return;
      if (tx.session.activeOperations[callID]) {
        blockTaskAdmission(`Native call ${callID} is already correlated`);
      }

      let engine;
      try {
        const profileRoot = this.ports.profilesDir;
        await resolveConfig(tx.session.profileId, profileRoot);
        engine = await this.ports.mutationOrchestrator.resolveEngine(
          tx.session.profileId,
          tx.session.schemaId
        );
      } catch (error) {
        blockTaskAdmission(
          `Cannot resolve workflow admission profile: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const derivedStageId = engine.deriveStage(tx.session);
      tx.session.currentStage = derivedStageId;
      const derivedStage = engine.getStages()[derivedStageId];
      if (!derivedStage?.loop || nestedStages(derivedStage).length === 0) {
        blockTaskAdmission(`Stage ${derivedStageId} does not declare an executable task loop`);
      }

      // Луп, который владеет списком этой задачи — не всегда стадия, в которой
      // сессия: стадия-луп может гнездить свой собственный луп
      // (`loop: $currentTask.id`), и задачи этого внутреннего лупа живут в
      // списке, закеированном по id родительской задачи. Допуск смотрел только
      // в список внешнего лупа, так что схема с вложенным лупом принималась, а
      // её дочерние задачи были всегда "not eligible" — форма могла быть
      // написана и никогда не запущена.
      const owner = this.resolveAdmissionLoop(tx.session, derivedStageId, derivedStage, taskId);
      if (!owner) {
        blockTaskAdmission(
          `Workflow task ${taskId} is not eligible in loopStage ${derivedStageId}`
        );
      }
      const { stageId: loopStageId, stage: loopStage, listKey } = owner;
      if (nestedStages(loopStage).length === 0) {
        blockTaskAdmission(`Stage ${loopStageId} does not declare an executable task loop`);
      }
      // Луп, не называющий dispatch, запускает одну задачу за раз. Требование поля
      // заставляло каждый профиль повторять бойлерплейт, и забывчивость его
      // останавливала луп с сообщением о лупе, который заявлен явно. Внутренний
      // собственный dispatch, ростер и бюджет лупа правят его задачами.
      // `serial` не несёт maxConcurrent — собственный union схемы так говорит, и
      // проверка ниже шорт-циркуитует на стратегии до чтения поля.
      const dispatch = loopStage.dispatch ?? { strategy: 'serial' as const };

      const tasks = tx.session.tasks[listKey]!;
      const task = tasks.find((candidate) => candidate.id === taskId)!;

      const nonterminalRuns = Object.values(tx.session.loopRuns).filter(
        (run) => run.taskId === taskId && isOpenLoopRun(run)
      );
      if (nonterminalRuns.length > 1) {
        blockTaskAdmission(`Workflow task ${taskId} has ambiguous active loop runs`);
      }
      const existingRun = nonterminalRuns[0];
      if (existingRun?.status === 'awaiting_decision') {
        blockTaskAdmission(`Workflow task ${taskId} is awaiting a retry decision`);
      }
      if (!existingRun && task.status !== 'pending') {
        blockTaskAdmission(`Workflow task ${taskId} is not pending`);
      }

      const stageId = existingRun?.stage ?? firstNestedStageId(loopStage)!;
      const stage = nestedStages(loopStage).find((candidate) => candidate.id === stageId);
      if (!stage) {
        blockTaskAdmission(`Stage ${stageId} is not declared by stage ${loopStageId}`);
      }
      // A nested stage may narrow its parent's roster; when it declares none,
      // the parent's list applies. This is the only place agent identity is
      // known, so it is the only place `allowedAgents` can be enforced.
      const allowedAgents = stage.allowedAgents ?? loopStage.allowedAgents;
      if (allowedAgents?.length && !agentIsAllowed(agent, allowedAgents, tx.session.profileId)) {
        blockTaskAdmission(
          `Agent ${agent} is not allowed in stage ${stageId}. Allowed: ${allowedAgents.join(', ')}`
        );
      }
      // task.editingAgents ограничивает, кто может держать мутирующие вызовы
      // инструментов этой задачи вообще. Идентичность агента известна только в
      // момент диспатча — нативный tool.execute.before хук не несет агента —
      // так что это принуждается здесь, отвергая сам диспатч, а не каждый write.
      //
      // Является ли эта стадия той, где происходит работа, спрашивается у её
      // ростера, а не у её `gates`. `stage.gates?.length === 0` был старым
      // тестом, и он false когда стадия не декларирует `gates:` вообще — а это
      // большинство стадий — так что проверка пропускалась ровно для того
      // случая, для которого она писалась, и задача, называющая своих
      // редакторов, пускала любого.
      //
      // Стадия, чей ростер допускает редактора — стадия, где происходит работа.
      // Никакой ростер — кто угодно может там бегать, редакторы в том числе.
      // Workflow, не декларирующий редакторов вообще, не может классифицировать
      // свои стадии, и это молчит вместо угадывания — каждый shipped профиль их
      // декларирует.
      const editors = engine.getEditingAgents();
      const roster = stage.allowedAgents ?? loopStage.allowedAgents;
      const stageMayEdit =
        editors.length > 0 &&
        (roster === undefined ||
          roster.some((candidate) => agentIsAllowed(candidate, editors, tx.session!.profileId)));

      if (
        stageMayEdit &&
        task.editingAgents?.length &&
        !agentIsAllowed(agent, task.editingAgents, tx.session.profileId)
      ) {
        blockTaskAdmission(
          `Agent ${agent} may not edit ${taskId}. editingAgents: [${task.editingAgents.join(', ')}]`
        );
      }
      // Стадия, декларирующая гейты, ждёт несколько вердиктов, поэтому может
      // иметь по одному вызову на гейт за раз — review и qa бегают вместе.
      // Любая другая стадия — один вызов за раз, и тот же агент никогда не
      // может держать два: один агент не может судить ту же работу дважды
      // одновременно.
      const running = Object.values(tx.session.activeOperations).filter(
        (operation) => operation.taskId === taskId && operation.status === 'running'
      );
      const gateCount = stage.gates?.length ?? 0;
      if (running.length > 0) {
        const sameAgent = running.some((operation) => operation.agent === agent);
        if (gateCount === 0) {
          blockTaskAdmission(`Workflow task ${taskId} already has an active call`);
        }
        if (sameAgent) {
          blockTaskAdmission(
            `Agent ${agent} already has an active call for workflow task ${taskId}`
          );
        }
        if (running.length >= gateCount) {
          blockTaskAdmission(
            `Stage ${stageId} is waiting on ${gateCount} verdict(s) and already has that many calls`
          );
        }
      }

      // Используем нормализованный контекст с фактами выбранной задачи — как при
      // проверке переходов. Сырой session имеет gates в виде массива Gate[], а
      // toGuardContext проецирует в факты с Record<string, GateStatus>, и включает
      // контекст задачи (task.id, task.status и т.д.) для guard-выражений.
      const guardContext = toGuardContext(tx.session, {
        id: task.id,
        status: task.status,
        listKey,
      });
      if (
        stage.entryGuards?.some(
          (guard) => !engine.evaluateGuard(guard, guardContext, { currentLoopListKey: listKey })
        )
      ) {
        blockTaskAdmission(`Entry guard rejected stage ${stageId}`);
      }

      const activeRuns = Object.values(tx.session.loopRuns).filter((run) => isOpenLoopRun(run));
      if (!existingRun) {
        const rejection = this.taskAdmissionRejection(
          dispatch,
          tasks,
          taskId,
          activeRuns,
          firstNestedStageId(loopStage)!,
          tx.session,
          listKey
        );
        if (rejection) {
          blockTaskAdmission(rejection);
        }
      }

      const runId = existingRun?.id ?? nextLoopRunId(tx.session);
      if (!existingRun) {
        tx.session.loopRuns[runId] = {
          id: runId,
          taskId,
          listKey,
          ancestry: this.resolveTaskAncestry(tx.session.tasks, listKey),
          stage: stageId,
          status: 'running',
          gates: {},
          round: 0,
        };
        task.status = 'running';
      }
      // Занятость стадии, которой принадлежит этот вызов. Вердикт, пришедший
      // после того как задача ушла, принадлежит законченному раунду.
      // Штамп в одном месте для обеих записей, так что они не могут расойтись.
      const round = tx.session.loopRuns[runId]?.round ?? 0;
      tx.session.activeOperations[callID] = {
        callId: callID,
        runId,
        taskId,
        agent,
        kind: 'task',
        status: 'running',
        startedAt: new Date().toISOString(),
        round,
        // The pre-move snapshot captured above, before admission. A missing
        // frame (no projectDir) leaves this unset — see D5.
        baseline: frame,
      };
      // Собственный штамп свежести вердикта, которым владеет механизм гейтов. В
      // отличие от операции выше, он не удаляется жизненным циклом мутации —
      // вердикт должен всё ещё судиться против своего раунда когда операции
      // уже нет.
      // Bounded: вызов, которому никогда не ответили, оставляет свой штамп
      // позади, и call ids сессии только накапливаются.
      const stampedCalls = Object.keys(tx.session.verdictProvenance);
      if (stampedCalls.length > 500) {
        for (const expired of stampedCalls.slice(0, stampedCalls.length - 500)) {
          delete tx.session.verdictProvenance[expired];
        }
      }

      upsertActiveTaskContext(
        tx.session,
        {
          runId,
          taskId,
          agent,
          callId: callID,
          status: 'running',
        },
        new Date().toISOString()
      );

      void this.ports.log('info', 'Workflow task admitted', {
        sessionID,
        callID,
        runId,
        taskId,
        agent,
        stage: stageId,
        displayDescription:
          typeof description === 'string' ? description.slice(match![0].length).trimStart() : '',
      });
    });
  }

  private async safeCaptureBaseline(): Promise<Record<string, string | null> | undefined> {
    if (!this.ports.projectDir) return undefined;
    try {
      return await captureBaseline(this.ports.projectDir);
    } catch (error) {
      void this.ports.log('warn', 'captureBaseline failed — proceeding without a frame', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private resolveAdmissionLoop(
    session: WorkflowSession,
    outerStageId: string,
    outerStage: StageDef,
    taskId: string
  ): { stageId: string; stage: StageDef; listKey: string } | null {
    const owners: Array<{ stageId: string; stage: StageDef; listKey: string }> = [];
    const walk = (stageId: string, stage: StageDef): void => {
      if (stage.loop) {
        const listKey = this.resolveAdmissionListKey(session, stage.loop, taskId);
        if (listKey) owners.push({ stageId, stage, listKey });
      }
      for (const nested of nestedStages(stage)) walk(`${stageId}/${nested.id}`, nested);
    };
    walk(outerStageId, outerStage);

    return (
      owners.find((owner) => owner.stageId === outerStageId) ??
      (owners.length === 1 ? owners[0]! : null)
    );
  }

  private resolveAdmissionListKey(
    session: WorkflowSession,
    loop: string,
    taskId: string
  ): string | null {
    if (loop !== '$currentTask.id') {
      return session.tasks[loop]?.some((task) => task.id === taskId) ? loop : null;
    }
    const matches = Object.entries(session.tasks)
      .filter(
        ([listKey, tasks]) =>
          /^task-[0-9]+$/.test(listKey) && tasks.some((task) => task.id === taskId)
      )
      .map(([listKey]) => listKey);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Два скоупа встречаются здесь, и различать их — вся работа.
   *
   * Стратегия `dispatch:` управляет одним циклом: `serial` значит одна задача
   * *этого списка* за раз, а `maxConcurrent` считает *прогоны этого списка*.
   * Они читают `cycleRuns`. Подсчёт каждого открытого прогона в сессии вместо
   * этого заставлял родителя отвергать своего ребёнка — родитель занимает
   * `parents`, цикл ребёнка владеет `task-1`, и прогон родителя отвергал
   * ребёнка с «Serial task cycle admits only the next unfinished task».
   * Родитель потом ждал ребёнка, которого не пускали запускаться.
   *
   * Перекрытие `writeScope` — другой скоуп и он сессионно-широкий: две задачи,
   * пишущие в одни пути, ломают атрибуцию инвариантов входят они в один цикл
   * или нет, потому что дифф разбит по путям, а не по времени.
   */
  private taskAdmissionRejection(
    dispatch: NonNullable<StageDef['dispatch']>,
    tasks: MutationTask[],
    taskId: string,
    activeRuns: LoopRun[],
    firstStageId: string,
    session: WorkflowSession,
    listKey: string
  ): string | null {
    const cycleRuns = activeRuns.filter((run) => run.listKey === listKey);

    if (dispatch.strategy !== 'serial' && cycleRuns.length >= dispatch.maxConcurrent) {
      return `Task cycle concurrency limit ${dispatch.maxConcurrent} is exhausted`;
    }

    const taskIndex = tasks.findIndex((task) => task.id === taskId);
    const firstUnfinishedIndex = tasks.findIndex(
      (task) => task.status === 'pending' || task.status === 'running'
    );
    if (dispatch.strategy === 'serial') {
      if (taskIndex !== firstUnfinishedIndex || cycleRuns.length > 0) {
        return `Serial task cycle admits only the next unfinished task`;
      }
      return null;
    }

    // Non-overlap applies to EVERY non-serial strategy (`parallel` и
    // `serial_with_overlap`), не только `parallel`: непересекающийся writeScope —
    // это то, что делает атрибуцию инвариантов возможной вообще, разделяя
    // дифф по путям вместо времени. `serial` допускает один прогон за раз и
    // тут ничего не требует. Отсутствующий/пустой writeScope ни с чем не
    // перекрывается, так что read-only задача всегда допустима (task-scope spec).
    const incoming = tasks[taskIndex];
    const overlapping = activeRuns.find((run) => {
      const running = findTask(session, run.taskId);
      return running !== undefined && scopesIntersect(incoming?.writeScope, running.writeScope);
    });
    if (overlapping) {
      let message = `Task ${taskId}'s writeScope overlaps running task ${overlapping.taskId}`;
      if (dispatch.strategy === 'parallel') {
        // Только `parallel` имеет альтернативу: под `serial_with_overlap`
        // порядок строгий, так что другого допустимого таска нет и ответ всегда
        // "wait".
        const runningTaskIds = new Set(activeRuns.map((run) => run.taskId));
        const admissibleNow = tasks.filter(
          (task) =>
            task.id !== taskId &&
            !runningTaskIds.has(task.id) &&
            (task.status === 'pending' || task.status === 'running') &&
            !activeRuns.some((run) => {
              const running = findTask(session, run.taskId);
              return running !== undefined && scopesIntersect(task.writeScope, running.writeScope);
            })
        );
        if (admissibleNow.length > 0) {
          message += `; admissible now: ${admissibleNow.map((task) => task.id).join(', ')}`;
        }
      }
      return message;
    }

    if (dispatch.strategy === 'parallel') return null;

    if (taskIndex === 0) return cycleRuns.length === 0 ? null : 'First task is already active';
    const priorTask = tasks[taskIndex - 1];
    const priorRun = cycleRuns.find((run) => run.taskId === priorTask.id);
    const priorIsTerminal = ['completed', 'failed', 'cancelled'].includes(priorTask.status);
    if (!priorIsTerminal && (!priorRun || priorRun.stage === firstStageId)) {
      return `Overlapping task cycle waits for ${priorTask.id} to leave ${firstStageId}`;
    }
    const earlierTaskStillPending = tasks
      .slice(0, taskIndex - 1)
      .some((task) => task.status === 'pending');
    return earlierTaskStillPending ? 'Overlapping task cycle must preserve task order' : null;
  }

  private resolveTaskAncestry(
    tasks: Record<string, Array<{ id?: string }>>,
    listKey: string
  ): Array<{ listKey: string; taskId: string }> {
    const ancestry: Array<{ listKey: string; taskId: string }> = [];
    let childListKey = listKey;
    const visited = new Set<string>();
    while (/^task-[0-9]+$/.test(childListKey) && !visited.has(childListKey)) {
      visited.add(childListKey);
      const parent = Object.entries(tasks).find(([, tasks]) =>
        tasks.some((task) => task.id === childListKey)
      );
      if (!parent) break;
      ancestry.unshift({ listKey: parent[0], taskId: childListKey });
      childListKey = parent[0];
    }
    return ancestry;
  }
}

export function createTaskAdmission(ports: TaskAdmissionPorts): TaskAdmission {
  return new TaskAdmissionImpl(ports);
}

export { isWorkflowTaskDescription };
