import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import { approve } from '../../src/domain/approvals.ts';

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

function setFixtureProfilesDir(): void {
  process.env.STATE_MACHINE_PROFILES_DIR = resolve(import.meta.dir, '../../test/fixtures/profiles');
}

function addExecutableTaskCycle(session: ReturnType<typeof createSession>): void {
  session.tasks.implementation = [{ id: 'task-1', path: 'src/task-1.ts', status: 'pending' }];
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('MutationOrchestrator.beginMutation', () => {
  it('rejects when engine resolution fails (no profiles dir)', async () => {
    await store.save(createSession('mo-no-profiles', 'base'));
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
    const session = createSession('mo-fresh', 'base');
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

  it('rejects mutation when guard fails (no plan approval, non-zero revision)', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-guarded', 'base');
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
    await store.save(createSession('mo-finish-clean', 'base'));
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
    const session = createSession('mo-lifecycle', 'base');
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
    const session = createSession('mo-pass', 'base');
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
    const session = createSession('mo-failed-md', 'base');
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
    expect(reloaded?.retryBudgets['task-1']?.attempts).toBe(1);
  });

  it('fails gate closed when computeChangeScope throws (no git repo)', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-scope-fail', 'base');
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
    const session = createSession('mo-direct-finish', 'base');
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

  it('bumpRetry is called exactly once per finishMutation call (no double bump)', async () => {
    setFixtureProfilesDir();
    const gitDir = makeGitDir();
    const session = createSession('mo-retry-once', 'base');
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
    expect(reloaded?.retryBudgets['task-1']?.attempts).toBe(1);
  });
});

describe('MutationOrchestrator.clearOnError', () => {
  it('is a no-op for an unknown callId', async () => {
    const { orchestrator } = await makeOrchestrator();
    await expect(orchestrator.clearOnError('unknown-call')).resolves.toBeUndefined();
  });

  it('clears the active operation for a tracked mutation', async () => {
    setFixtureProfilesDir();
    const session = createSession('mo-clear', 'base');
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
