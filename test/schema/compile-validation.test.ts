import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { compileWorkflow } from '../../src/schema/compile-workflow.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';
import { createTask } from '../support/task-factory.ts';

/**
 * What the compiler refuses at load.
 *
 * Every one of these was previously a silence: a guard that read false
 * forever, a verdict recorded against a gate the profile never declared, a
 * retry that spent a counter no one was watching. A defect in the file should
 * stop the workflow when the file is read.
 */

/** What the fixture profile declares, so a stage's `gates:` has a list to be wrong about. */
const DECLARED_GATES = [{ id: 'invariants' }, { id: 'review' }, { id: 'qa' }];

function schema(
  stages: ResolvedSchema['stages'],
  transitions: ResolvedSchema['transitions'] = []
): ResolvedSchema {
  return { source: 'test.yaml', stages, transitions, gates: DECLARED_GATES };
}

function messages(input: ResolvedSchema): string[] {
  return compileWorkflow(input).errors.map((error) => error.message);
}

describe('a workflow that cannot run is refused when it is read', () => {
  it('refuses a loop no task can finish', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        transitions: [{ from: 'code', to: 'verify' }],
      },
    });
    expect(messages(input)).toContain(
      'Loop "execution" declares transitions but none of them reaches "done", so no task can ever finish it'
    );
  });

  it('refuses a loop with nothing to run', () => {
    expect(messages(schema({ execution: { loop: 'implementation' } }))).toEqual([
      'Stage "execution" cycles over "implementation" but declares no stages to run',
    ]);
  });

  it('refuses transitions on a stage that has no loop', () => {
    const input = schema({
      planning: { transitions: [{ from: 'a', to: 'b' }] },
    });
    expect(messages(input)).toContain(
      'Stage "planning" declares transitions but no loop to move a task through'
    );
  });

  it('refuses a gate the profile does not declare', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { verify: { gates: ['review', 'security'] } },
      },
    });
    expect(messages(input)).toContain('Gate "security" is not a gate this profile declares');
  });

  it('refuses a gate the profile does not declare on an outer stage too', () => {
    expect(messages(schema({ validation: { gates: ['smoke'] } }))).toContain(
      'Gate "smoke" is not a gate this profile declares'
    );
  });

  it("reports a nested stage's bad gate once, not once per level that can see it", () => {
    // The parent's walk checked each nested stage's gates and then recursed
    // into that stage, which checked them again under the same path. Every
    // such error was reported twice; `toContain` cannot see a duplicate.
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { verify: { gates: ['security'] } },
      },
    });
    const gateErrors = messages(input).filter((message) => message.includes('Gate "security"'));
    expect(gateErrors).toHaveLength(1);
  });

  it('accepts any gate name when the profile declares none', () => {
    // No declaration is not an empty declaration: there is nothing to be wrong
    // about, so the compiler must not invent a list of its own to reject against.
    const undeclared: ResolvedSchema = {
      source: 'test.yaml',
      stages: { validation: { gates: ['smoke'] } },
      transitions: [],
    };
    expect(messages(undeclared)).toEqual([]);
  });

  it('refuses a transition to a stage the loop does not have', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        transitions: [{ from: 'verify', to: 'commit' }],
      },
    });
    expect(messages(input)).toContain(
      'Transition verify → commit names "commit", which is not a stage of "execution"'
    );
  });

  it('refuses a retry that spends a budget other than the task’s own', () => {
    const input = schema({
      execution: {
        loop: 'implementation',
        stages: { code: {}, verify: {} },
        transitions: [{ from: 'verify', to: 'code', effects: [{ bumpRetry: 'cycles' }] }],
      },
    });
    expect(messages(input)).toContain(
      'Transition verify → code bumps "cycles"; inside a loop the budget is the task’s own, written as task.id'.replace(
        '’',
        "'"
      )
    );
  });

  it('accepts the shape the shipped workflow uses', () => {
    const input = schema(
      {
        planning: {},
        execution: {
          loop: 'implementation',
          stages: { code: {}, verify: { gates: ['review', 'qa'] } },
          transitions: [
            { from: 'code', to: 'verify' },
            { from: 'verify', to: 'done' },
            { from: 'verify', to: 'code', effects: [{ bumpRetry: 'task.id' }] },
          ],
        },
        validation: { gates: ['review', 'qa'] },
        commit: {},
        done: {},
      },
      [
        { from: 'planning', to: 'execution' },
        { from: 'execution', to: 'validation' },
        { from: 'validation', to: 'commit' },
        { from: 'commit', to: 'done' },
      ]
    );
    expect(messages(input)).toEqual([]);
  });
});

// ─── The refusal reaches the operator ─────────────────────────────────────────

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

beforeEach(async () => {
  previousStore = process.env.STATE_MACHINE_STORE_DIR;
  previousProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
  storeDirectory = await mkdtemp(join(tmpdir(), 'compile-store-'));
  profilesDirectory = await mkdtemp(join(tmpdir(), 'compile-profiles-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDirectory;
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDirectory;

  const profileDirectory = join(profilesDirectory, 'broken');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, 'profile.json'),
    JSON.stringify({ id: 'broken', schemas: ['cycle.yaml'] }),
    'utf-8'
  );
  await writeFile(
    join(profileDirectory, 'cycle.yaml'),
    [
      'stages:',
      '  EXECUTION:',
      '    loop: implementation',
      '    stages:',
      '      code: {}',
      '      verify:',
      '        gates: [review]',
      '    transitions:',
      // The loop can finish, so the only defect left is the edge below.
      '      - from: verify',
      '        to: done',
      // `commit` is not a stage of this loop.
      '      - from: verify',
      '        to: commit',
      'stageAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );

  const store = new WorkflowStore(storeDirectory);
  const session = createSession('s1', 'broken', 'cycle');
  session.tasks.implementation = [createTask()];
  await store.save(session);
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.STATE_MACHINE_STORE_DIR;
  else process.env.STATE_MACHINE_STORE_DIR = previousStore;
  if (previousProfiles === undefined) delete process.env.STATE_MACHINE_PROFILES_DIR;
  else process.env.STATE_MACHINE_PROFILES_DIR = previousProfiles;
  await rm(storeDirectory, { recursive: true, force: true });
  await rm(profilesDirectory, { recursive: true, force: true });
});

describe('a schema that does not compile stops the work', () => {
  it('refuses the task rather than running a workflow that cannot finish', async () => {
    const hooks = createRuntime(pluginInput());

    let refusal = '';
    try {
      await hooks['tool.execute.before']!(
        { tool: 'task', sessionID: 's1', callID: 'call-1' },
        {
          args: {
            subagent_type: 'code',
            description: '[workflow-task:task-1] work',
            prompt: 'do it',
          },
        }
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    // The refusal must name the defect in the file, not merely fail somewhere.
    expect(refusal, 'a workflow with a transition to nowhere was admitted').toContain(
      'Transition verify → commit names "commit"'
    );
  });
});
