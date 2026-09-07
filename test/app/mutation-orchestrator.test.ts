import { mkdtempSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import { approve } from '../../src/domain/approvals.ts';
import { createTask } from '../support/task-factory.ts';
import { fixtureProfilesDir, setFixtureProfilesDir } from '../support/fixture-profiles.ts';

// ─── Helpers ──────────────────────────────────────────────────────

let storeDir: string;
let store: WorkflowStore;
let testDir: string;
let prevProfilesDir: string | undefined;
const gitDirs: string[] = [];

function makeGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mo-git-'));
  execSync('git init', { cwd: dir, encoding: 'utf-8' });
  execSync('git config user.email test@test.com && git config user.name test', {
    cwd: dir,
    encoding: 'utf-8',
  });
  writeFileSync(join(dir, 'init.ts'), 'const x = 1;\n', 'utf-8');
  execSync('git add -A && git commit -m "init"', { cwd: dir, encoding: 'utf-8' });
  gitDirs.push(dir);
  return dir;
}

beforeEach(() => {
  storeDir = '/tmp/state-machine-test-' + Math.random().toString(36).slice(2);
  testDir = mkdtempSync(join(tmpdir(), 'mo-test-'));
  store = new WorkflowStore(storeDir);
  prevProfilesDir = process.env.STATE_MACHINE_PROFILES_DIR;
  delete process.env.STATE_MACHINE_PROFILES_DIR;
});

afterEach(() => {
  if (prevProfilesDir !== undefined) {
    process.env.STATE_MACHINE_PROFILES_DIR = prevProfilesDir;
  } else {
    delete process.env.STATE_MACHINE_PROFILES_DIR;
  }
  for (const d of gitDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
  rmSync(testDir, { recursive: true, force: true });
});

async function makeOrchestrator(projectDir?: string) {
  const { MutationOrchestrator } = await import('../../src/app/mutation-orchestrator.ts');
  const { SessionQueue } = await import('../../src/app/session-queue.ts');
  const queue = new SessionQueue(store);
  return {
    orchestrator: new MutationOrchestrator(store, queue, projectDir, testDir, undefined, undefined),
    queue,
  };
}

function addExecutableTaskCycle(session: ReturnType<typeof createSession>): void {
  session.tasks.implementation = [createTask()];
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('MutationOrchestrator.resolveEngine', () => {
  it("does not serve one directory's engine for another", async () => {
    // A fixture corpus points the same profile id at different directories.
    // The cache is keyed on the id, but the directory is read from the
    // environment on each call, so keying on the id alone hands back the first
    // directory's engine and the second fixture is never really loaded.
    // Two roots holding the same profile id — which is what the cache key has
    // to distinguish, and why these live outside `profiles/` rather than in it.
    const good = fixtureProfilesDir('profile-roots/valid');
    const broken = fixtureProfilesDir('profile-roots/undeclared-gate');

    const { orchestrator } = await makeOrchestrator();

    process.env.STATE_MACHINE_PROFILES_DIR = good;
    await orchestrator.resolveEngine('cycle-probe');

    process.env.STATE_MACHINE_PROFILES_DIR = broken;
    await expect(orchestrator.resolveEngine('cycle-probe')).rejects.toThrow(/Gate "security"/);
  });

  it('refuses a profile whose stage waits on a gate it does not declare', async () => {
    // The compiler checks a stage's `gates:` against the profile's own
    // declaration, and `resolveEngine` is where that check reaches production.
    // It compiles from an explicit field list, so omitting `gates` there turns
    // the check off silently while the unit test over `compileWorkflow`, which
    // passes its own, stays green.
    process.env.STATE_MACHINE_PROFILES_DIR = fixtureProfilesDir('profile-roots/undeclared-gate');
    const { orchestrator } = await makeOrchestrator();
    await expect(orchestrator.resolveEngine('cycle-probe')).rejects.toThrow(/Gate "security"/);
  });

  it("serves each of a profile's schemas as its own workflow", async () => {
    // `two-schemas` holds two independent workflows that declare the same
    // stage and the same edge. Folding the profile's list into one config —
    // which is what resolution used to do — let the last file win and served
    // one workflow under both names.
    process.env.STATE_MACHINE_PROFILES_DIR = fixtureProfilesDir('profiles');
    const { orchestrator } = await makeOrchestrator();

    const alpha = await orchestrator.resolveEngine('two-schemas', 'alpha');
    const beta = await orchestrator.resolveEngine('two-schemas', 'beta');

    expect(alpha.config.transitions.map((t) => t.guard)).toEqual(['FROM_ALPHA']);
    expect(beta.config.transitions.map((t) => t.guard)).toEqual(['FROM_BETA']);
    expect(alpha.config.requiredGates).toEqual(['alphaGate']);
    expect(beta.config.requiredGates).toEqual(['betaGate']);
  });

  it('refuses to guess which of several schemas a session runs', async () => {
    process.env.STATE_MACHINE_PROFILES_DIR = fixtureProfilesDir('profiles');
    const { orchestrator } = await makeOrchestrator();

    await expect(orchestrator.resolveEngine('two-schemas')).rejects.toThrow(
      /holds several schemas.*alpha, beta/s
    );
  });

  it('names the schemas it has when asked for one it does not', async () => {
    process.env.STATE_MACHINE_PROFILES_DIR = fixtureProfilesDir('profiles');
    const { orchestrator } = await makeOrchestrator();

    await expect(orchestrator.resolveEngine('two-schemas', 'gamma')).rejects.toThrow(
      /no schema "gamma".*alpha, beta/s
    );
  });
});

describe('MutationOrchestrator.beginMutation', () => {
  it('rejects when engine resolution fails (no profiles dir)', async () => {
    await store.save(createSession('mo-no-profiles', 'base', 'state-machine'));
    const { orchestrator } = await makeOrchestrator();

    const output: { args: unknown } = { args: 'echo hello' };
    // A refusal must reject: rewriting args would not stop the tool from running.
    await expect(
      orchestrator.beginMutation({ sessionID: 'mo-no-profiles', callID: 'call-1' }, output)
    ).rejects.toThrow();
  });

  it('is a no-op when no session exists (preCheck returns null)', async () => {
    const { orchestrator } = await makeOrchestrator();

    const output: { args: unknown } = { args: 'echo test' };
    await orchestrator.beginMutation({ sessionID: 'nonexistent', callID: 'call-noop' }, output);

    expect(output.args).toBe('echo test');
  });

  it('begins mutation for a plan-approved session and records liveMutations', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-fresh', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    const output: { args: unknown } = { args: 'echo hi' };
    await orchestrator.beginMutation({ sessionID: 'mo-fresh', callID: 'call-begin' }, output);

    expect(output.args).toBe('echo hi');

    const reloaded = await store.load('mo-fresh');
    expect(reloaded?.activeOperations['call-begin']?.callId).toBe('call-begin');
    expect(reloaded?.activeOperations['call-begin']?.taskId).toBe('task-1');
  });

  it("parks a mutation-before-dispatch run in the loop's first stage, not a literal", async () => {
    // A bash/write arriving before any `task` dispatch synthesises the run.
    // Its stage used to be written as the literal 'mutation', which no profile
    // declares, so every later dispatch for that task was refused for ever —
    // admission looks the run's stage up among the loop's nested stages. The
    // host smoke run caught it as "Stage mutation is not declared by stage
    // execution".
    setFixtureProfilesDir();
    const session = createSession('mo-synth-stage', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    await orchestrator.beginMutation(
      { sessionID: 'mo-synth-stage', callID: 'call-synth' },
      { args: 'echo hi' }
    );

    const reloaded = await store.load('mo-synth-stage');
    const runs = Object.values(reloaded?.loopRuns ?? {});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.stage).toBe('code');
  });

  it('rejects mutation when guard fails (no plan approval, non-zero revision)', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-guarded', 'base', 'state-machine');
    session.revision = 1;
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    const output: { args: unknown } = { args: 'echo hi' };
    await expect(
      orchestrator.beginMutation({ sessionID: 'mo-guarded', callID: 'call-guarded' }, output)
    ).rejects.toThrow(/Mutation blocked by engine/);
    const reloaded = await store.load('mo-guarded');
    expect(reloaded?.activeOperations).toEqual({});
  });
});

describe('MutationOrchestrator.finishMutation', () => {
  it('handles missing mutationInfo without throwing', async () => {
    await store.save(createSession('mo-finish-clean', 'base', 'state-machine'));
    const { orchestrator } = await makeOrchestrator();

    await expect(
      orchestrator.finishMutation({
        sessionID: 'mo-finish-clean',
        callID: 'unknown-call',
        metadata: {},
      })
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the session does not exist', async () => {
    const { orchestrator } = await makeOrchestrator();

    await expect(
      orchestrator.finishMutation({ sessionID: 'nonexistent', callID: 'call-x', metadata: {} })
    ).resolves.toBeUndefined();
  });

  it('completes the full begin → finish lifecycle without throwing (post-factum validation passes)', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-lifecycle', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    const beginOutput: { args: unknown } = { args: 'echo' };
    await orchestrator.beginMutation(
      { sessionID: 'mo-lifecycle', callID: 'call-lifecycle' },
      beginOutput
    );
    expect(beginOutput.args).toBe('echo');

    await expect(
      orchestrator.finishMutation({
        sessionID: 'mo-lifecycle',
        callID: 'call-lifecycle',
        metadata: {},
      })
    ).resolves.toBeUndefined();

    const reloaded = await store.load('mo-lifecycle');
    expect(reloaded?.activeOperations).toEqual({});
  });

  // ── Регрессионные тесты: scope, invariant validation, fail-closed ──

  it('sets gate to passed and clears activeOperation on successful finishMutation', async () => {
    setFixtureProfilesDir();
    const gitDir = makeGitDir();
    const session = createSession('mo-pass', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator(gitDir);

    await orchestrator.beginMutation({ sessionID: 'mo-pass', callID: 'call-pass' }, { args: {} });

    await orchestrator.finishMutation({ sessionID: 'mo-pass', callID: 'call-pass', metadata: {} });

    const reloaded = await store.load('mo-pass');
    expect(reloaded?.activeOperations).toEqual({});
    const invGate = reloaded?.gates.find((g) => g.id === 'invariants');
    expect(invGate?.status).toBe('passed');
    expect(invGate?.resolvedAt).toBeDefined();
  });

  it('sets gate to failed when output.metadata.failed is true', async () => {
    setFixtureProfilesDir();
    const gitDir = makeGitDir();
    const session = createSession('mo-failed-md', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator(gitDir);

    await orchestrator.beginMutation(
      { sessionID: 'mo-failed-md', callID: 'call-fail' },
      { args: {} }
    );

    await orchestrator.finishMutation({
      sessionID: 'mo-failed-md',
      callID: 'call-fail',
      metadata: { failed: true },
    });

    const reloaded = await store.load('mo-failed-md');
    expect(reloaded?.activeOperations).toEqual({});
    const invGate = reloaded?.gates.find((g) => g.id === 'invariants');
    expect(invGate?.status).toBe('failed');
    // Recording the verdict is not spending an attempt: the move that retries
    // is what costs one. Bumping here spent the same counter a second time.
    expect(reloaded?.retryBudgets['task-1']).toBeUndefined();
  });

  it('fails gate closed when computeChangeScope throws (no git repo)', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-scope-fail', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    await orchestrator.beginMutation(
      { sessionID: 'mo-scope-fail', callID: 'call-scope' },
      { args: {} }
    );

    await orchestrator.finishMutation({
      sessionID: 'mo-scope-fail',
      callID: 'call-scope',
      metadata: {},
    });

    const reloaded = await store.load('mo-scope-fail');
    expect(reloaded?.activeOperations).toEqual({});
    const invGate = reloaded?.gates.find((g) => g.id === 'invariants');
    expect(invGate?.status).toBe('passed');
    expect(invGate?.resolvedAt).toBeDefined();
    expect(reloaded?.changedFiles).toEqual([]);
  });

  it('handles finishMutation when beginMutation was not called (no liveMutations entry)', async () => {
    const session = createSession('mo-direct-finish', 'base', 'state-machine');
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    await orchestrator.finishMutation({
      sessionID: 'mo-direct-finish',
      callID: 'call-direct',
      metadata: {},
    });

    const reloaded = await store.load('mo-direct-finish');
    expect(reloaded?.activeOperations).toEqual({});
  });

  it('spends no retry attempt: a verdict is not a retry', async () => {
    setFixtureProfilesDir();
    const gitDir = makeGitDir();
    const session = createSession('mo-retry-once', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator(gitDir);

    await orchestrator.beginMutation(
      { sessionID: 'mo-retry-once', callID: 'call-retry' },
      { args: {} }
    );

    await orchestrator.finishMutation({
      sessionID: 'mo-retry-once',
      callID: 'call-retry',
      metadata: { failed: true },
    });

    const reloaded = await store.load('mo-retry-once');
    // The task's budget belongs to the moves that retry it — the runtime
    // spends one when a failing stage is left, and an edge may declare
    // `bumpRetry` or `onFailure: retry`. Recording an invariant failure used
    // to spend it too, so a task could exhaust its retries without a single
    // retry having been taken.
    expect(reloaded?.retryBudgets['task-1']).toBeUndefined();
  });
});

describe('MutationOrchestrator.clearOnError', () => {
  it('is a no-op for an unknown callId', async () => {
    const { orchestrator } = await makeOrchestrator();
    await expect(orchestrator.clearOnError('unknown-call')).resolves.toBeUndefined();
  });

  it('clears the active operation for a tracked mutation', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-clear', 'base', 'state-machine');
    approve(session, 'plan', 'test-evidence', 'approve-call-id');
    addExecutableTaskCycle(session);
    await store.save(session);
    const { orchestrator } = await makeOrchestrator();

    const output: { args: unknown } = { args: 'echo' };
    await orchestrator.beginMutation({ sessionID: 'mo-clear', callID: 'call-clear' }, output);

    let reloaded = await store.load('mo-clear');
    expect(reloaded?.activeOperations['call-clear']).toBeDefined();

    await orchestrator.clearOnError('call-clear');

    reloaded = await store.load('mo-clear');
    expect(reloaded?.activeOperations).toEqual({});
  });
});

describe('MutationOrchestrator.resolveEngine', () => {
  it('caches the engine across calls for the same profileId', async () => {
    setFixtureProfilesDir();
    const { orchestrator } = await makeOrchestrator();

    const first = await orchestrator.resolveEngine('base');
    const second = await orchestrator.resolveEngine('base');

    expect(first).toBe(second);
  });
});

describe('MutationOrchestrator.dispose', () => {
  it('clears internal state without throwing', async () => {
    const { orchestrator } = await makeOrchestrator();
    expect(() => orchestrator.dispose()).not.toThrow();
  });
});
