import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';

/**
 * A stage may run several agents at once — review and qa in parallel — so a
 * `<workflow-result>` names the gate it closes, never the stage it ran in.
 * The stage is passed when every gate it declares is passed, and failed as
 * soon as one fails. See docs/stage-model-plan.md.
 */

let storeDirectory: string;
let profilesDirectory: string;
let previousStore: string | undefined;
let previousProfiles: string | undefined;

function pluginInput(): PluginInput {
  return {
    client: {} as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/test',
    worktree: '/tmp/test',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

async function writeProfile(transitions = false, guardInvariants = false): Promise<void> {
  const profileDirectory = join(profilesDirectory, 'verify');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'verify', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    dispatch:',
      '      strategy: serial',
      '    retryBudget:',
      '      maximum: 3',
      '    stages:',
      '      code:',
      "        allowedAgents: ['code']",
      '      verify:',
      "        allowedAgents: ['review', 'qa']",
      '        gates: [review, qa]',
      ...(guardInvariants
        ? [
            '    transitions:',
            '      - from: code',
            '        to: verify',
            "        guard: \"session.gates.invariants == 'passed'\"",
            '      - from: verify',
            '        to: done',
            "        guard: \"task.gates.review == 'passed' && task.gates.qa == 'passed'\"",
          ]
        : []),
      ...(transitions
        ? [
            '      commit: {}',
            '    transitions:',
            '      - from: code',
            '        to: verify',
            '      - from: commit',
            '        to: done',
            '      - from: verify',
            '        to: commit',
            "        guard: \"task.gates.review == 'passed' && task.gates.qa == 'passed'\"",
            '      - from: verify',
            '        to: code',
            "        guard: \"task.gates.review == 'failed' || task.gates.qa == 'failed'\"",
            '        effects:',
            '          - bumpRetry: task.id',
          ]
        : []),
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );
}

async function seed(): Promise<WorkflowStore> {
  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'verify');
  session.tasks.implementation = [{ id: 'task-1', path: 'src/a.ts', status: 'pending' }];
  await store.save(session);
  return store;
}

async function dispatch(hooks: Hooks, callID: string, agent: string): Promise<void> {
  await hooks['tool.execute.before']!(
    { tool: 'task', sessionID: 's1', callID },
    {
      args: {
        subagent_type: agent,
        description: '[workflow-task:task-1] work',
        prompt: 'do it',
      },
    }
  );
}

/** Report a verdict for one gate, and return what the agent was told back. */
async function report(
  hooks: Hooks,
  callID: string,
  gate: string,
  status: 'pass' | 'fail',
  agent = gate === 'code' ? 'code' : gate === 'review' ? 'review' : 'qa'
): Promise<string> {
  const tag = `<workflow-result>${JSON.stringify({
    stage: gate,
    status,
    summary: `${gate} ${status}`,
    evidence: [`${gate}-evidence`],
  })}</workflow-result>`;
  const output = { title: 'workflow task', output: tag, metadata: {} };
  // The host reports which subagent produced the result; a verdict from an
  // unnamed caller is not a verdict.
  await hooks['tool.execute.after']!(
    { tool: 'task', sessionID: 's1', callID, args: { subagent_type: agent } },
    output
  );
  return output.output;
}

async function load(store: WorkflowStore): Promise<WorkflowSession> {
  const session = await store.load('s1');
  if (!session) throw new Error('session was not persisted');
  return session;
}

function run(session: WorkflowSession) {
  return Object.values(session.loopRuns)[0]!;
}

beforeEach(async () => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'verify-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'verify-profiles-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;
  await writeProfile();
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
});

describe('a stage waits for every gate it declares', () => {
  /** Walk the task out of `code` and into `verify`. */
  async function reachVerify(hooks: Hooks, store: WorkflowStore): Promise<void> {
    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');
    expect(run(await load(store)).stage).toBe('verify');
  }

  it('holds the stage until both verifiers have reported', async () => {
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'pass');

    const midway = run(await load(store));
    expect(midway.gates).toEqual({ review: 'passed' });
    expect(midway.stage, 'the stage moved on one verdict').toBe('verify');
    expect(midway.status).toBe('running');
  });

  it('completes the task once every gate has passed', async () => {
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'pass');
    await dispatch(hooks, 'call-qa', 'qa');
    await report(hooks, 'call-qa', 'qa', 'pass');

    const session = await load(store);
    expect(run(session).status).toBe('completed');
    expect(session.tasks.implementation[0]!.status).toBe('completed');
  });

  it('fails the stage as soon as one gate fails, without waiting for the other', async () => {
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'fail');

    const session = await load(store);
    expect(run(session).stage, 'a failed gate sends the task back').toBe('code');
    expect(session.retryBudgets['task-1']?.attempts).toBe(1);
  });

  it('starts a stage with no verdicts carried over from the last one', async () => {
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    expect(run(await load(store)).gates).toEqual({});
  });
});

describe('editing again clears the verdicts about the old code', () => {
  it('drops the task gates when a new mutation starts', async () => {
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');
    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'pass');
    expect(run(await load(store)).gates).toEqual({ review: 'passed' });

    // A second edit inside the same stage — an architect reworking a plan, a
    // coder fixing what review found. The review verdict was about the code as
    // it was, so it must not survive the edit.
    const { beginMutation } = await import('../../src/domain/operation-lifecycle.ts');
    const session = await load(store);
    delete session.activeOperations['call-review'];
    beginMutation(session, 'call-edit', 'code');
    await store.save(session);

    expect(run(await load(store)).gates).toEqual({});
  });
});

describe('a result naming a gate the stage did not declare', () => {
  it('is refused, records nothing, and says why', async () => {
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');

    await dispatch(hooks, 'call-review', 'review');
    const told = await report(hooks, 'call-review', 'security', 'pass');

    const session = await load(store);
    expect(told).toContain('[workflow-result-rejected]');
    expect(told).toContain('review, qa');
    expect(run(session).gates, 'an undeclared gate was recorded').toEqual({});
    expect(run(session).stage).toBe('verify');
  });
});

describe('a loop moved by its own transitions', () => {
  /** The execution loop from docs/stage-model-plan.md, variant B. */
  async function reachVerify(hooks: Hooks, store: WorkflowStore): Promise<void> {
    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');
    expect(run(await load(store)).stage).toBe('verify');
  }

  it('takes the branch its guard names, not the next stage in the list', async () => {
    await writeProfile(true);
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'pass');
    await dispatch(hooks, 'call-qa', 'qa');
    await report(hooks, 'call-qa', 'qa', 'pass');

    expect(run(await load(store)).stage).toBe('commit');
  });

  it('sends a failed task back to code and spends its own retry budget', async () => {
    await writeProfile(true);
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await dispatch(hooks, 'call-qa', 'qa');
    await report(hooks, 'call-qa', 'qa', 'fail');

    const session = await load(store);
    expect(run(session).stage).toBe('code');
    expect(session.retryBudgets['task-1']).toMatchObject({ attempts: 1 });
    expect(run(session).gates, 'the failed verdict was carried into code').toEqual({});
  });

  it('waits at verify while only one verifier has answered', async () => {
    await writeProfile(true);
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'pass');

    expect(run(await load(store)).stage).toBe('verify');
  });
});

describe('two verifiers work the same task at once', () => {
  async function reachVerify(hooks: Hooks, store: WorkflowStore): Promise<void> {
    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');
    expect(run(await load(store)).stage).toBe('verify');
  }

  /** Dispatch and report the blocked reason, if the plugin refused. */
  async function tryDispatch(hooks: Hooks, callID: string, agent: string): Promise<string> {
    try {
      await dispatch(hooks, callID, agent);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('admits review and qa together', async () => {
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    expect(await tryDispatch(hooks, 'call-review', 'review')).toBe('');
    expect(
      await tryDispatch(hooks, 'call-qa', 'qa'),
      'the second verifier was refused while the first was working'
    ).toBe('');

    const session = await load(store);
    expect(Object.keys(session.activeOperations).sort()).toEqual(['call-qa', 'call-review']);
  });

  it('refuses the same agent twice — one agent cannot judge the same work twice at once', async () => {
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await reachVerify(hooks, store);

    await tryDispatch(hooks, 'call-review', 'review');
    expect(await tryDispatch(hooks, 'call-review-2', 'review')).toContain('already has an active call');
  });

  it('keeps a stage without gates to one call at a time', async () => {
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    // `code` declares no gates, so it is one call at a time.
    await tryDispatch(hooks, 'call-code', 'code');
    expect(await tryDispatch(hooks, 'call-code-2', 'code')).toContain('already has an active call');
  });
});

describe('an errored tool releases the task it was holding', () => {
  it('reads the part where the host actually puts it', async () => {
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-code', 'code');
    expect(Object.keys((await load(store)).activeOperations)).toEqual(['call-code']);

    // OpenCode emits `message.part.updated` with the part under
    // `properties.part`. Reading `event.part` found nothing, so an errored
    // tool left its operation running for ever.
    await hooks.event!({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 's1',
          part: { id: 'prt_1', callID: 'call-code', state: { status: 'error' } },
        },
      },
    } as never);

    const session = await load(store);
    expect(
      session.activeOperations['call-code']?.status,
      'the operation was left running after its tool errored'
    ).toBe('interrupted');
  });
});

describe('the retry budget path clears verdicts too', () => {
  it('sends a failed task back to the first stage with no gates carried over', async () => {
    // No transitions: the loop falls back to declaration order, and a failure
    // goes through the retry budget rather than an edge. That path used to
    // keep the failed verdict, so the task was judged on work it had not redone.
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());
    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');

    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'fail');

    const session = await load(store);
    expect(run(session).stage).toBe('code');
    expect(run(session).gates, 'the failure was carried back into code').toEqual({});
  });
});

describe('a guard inside a loop reads the session the same way one outside it does', () => {
  it('sees a session gate as a status, not as an array', async () => {
    // `session.gates.invariants == 'passed'` is the guard base.yaml uses on
    // `code → verify`. Outer transitions were handed normalised facts, where
    // gates are a map; inner ones got the raw session, where gates are an
    // array — so the same expression read a status outside the loop and
    // undefined inside it, and the task never left `code`.
    await writeProfile(false, true);
    const store = await seed();
    const hooks = createRuntime(pluginInput());

    const session = await load(store);
    const invariants = session.gates.find((gate) => gate.id === 'invariants')!;
    invariants.status = 'passed';
    await store.save(session);

    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');

    expect(run(await load(store)).stage, 'the guard could not read the session gate').toBe('verify');
  });

  it('holds the task while that gate has not passed', async () => {
    await writeProfile(false, true);
    const store = await seed();
    const hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');

    expect(run(await load(store)).stage).toBe('code');
  });
});

describe('a verdict from a round that is over', () => {
  it('does not spend the retry budget a second time', async () => {
    // Review and qa work `verify` together. Review fails, the task goes back to
    // `code` and pays one attempt. QA is still working, and its verdict — about
    // the code that was already judged — must not cost a second attempt.
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');

    await dispatch(hooks, 'call-review', 'review');
    await dispatch(hooks, 'call-qa', 'qa');

    await report(hooks, 'call-review', 'review', 'fail');
    const afterReview = await load(store);
    expect(run(afterReview).stage).toBe('code');
    expect(afterReview.retryBudgets['task-1']?.attempts).toBe(1);

    // The straggler reports on the round that has already ended.
    const told = await report(hooks, 'call-qa', 'qa', 'fail');

    const afterQa = await load(store);
    expect(told).toContain('[workflow-result-stale]');
    expect(
      afterQa.retryBudgets['task-1']?.attempts,
      'one round of review spent the budget twice'
    ).toBe(1);
    expect(run(afterQa).stage).toBe('code');
  });

  it('still accepts a verdict for the round the task is actually in', async () => {
    await writeProfile();
    const store = await seed();
    const hooks = createRuntime(pluginInput());

    await dispatch(hooks, 'call-code', 'code');
    await report(hooks, 'call-code', 'code', 'pass');
    await dispatch(hooks, 'call-review', 'review');
    await report(hooks, 'call-review', 'review', 'pass');

    expect(run(await load(store)).gates).toEqual({ review: 'passed' });
  });
});
