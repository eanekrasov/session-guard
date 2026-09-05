import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowStore, createSession } from '../../src/session/session-store.ts';
import { SessionQueue } from '../../src/app/session-queue.ts';
import { StateMachineEngine, type EvaluateGuardFn } from '../../src/domain/engine.ts';
import type { WorkflowSession } from '../../src/session/session-schema.ts';
import type { EngineConfig } from '../../src/domain/engine.ts';

// ─── Minimal engine config (no actionGuards) ─────────────────────
const NOOP_ENGINE_CONFIG: EngineConfig = {
  transitions: [],
};

const NOOP_EVALUATE_GUARD: EvaluateGuardFn = () => true;

function createNoopEngine(): StateMachineEngine {
  return new StateMachineEngine(NOOP_ENGINE_CONFIG, NOOP_EVALUATE_GUARD);
}

// ─── Helpers ──────────────────────────────────────────────────────

let storeDir: string;
let store: WorkflowStore;
let queue: SessionQueue;

beforeEach(() => {
  storeDir = '/tmp/state-machine-test-' + Math.random().toString(36).slice(2);
  store = new WorkflowStore(storeDir);
  queue = new SessionQueue(store);
});

async function drainQueue(rootSessionId: string): Promise<void> {
  await queue.enqueue(rootSessionId, async () => {});
}

function mockLogFn() {
  return vi.fn();
}

async function makeOrchestrator(engine?: StateMachineEngine, log?: ReturnType<typeof vi.fn>) {
  const { MutationOrchestrator } = await import('../../src/app/mutation-orchestrator.ts');

  // Create orchestrator but override resolveEngine to return our noop engine
  const orch = new MutationOrchestrator(store, queue, '/tmp/test', '/tmp/test', log ?? mockLogFn());

  if (engine) {
    // Monkey-patch resolveEngine to return our test engine
    const origResolve = orch.resolveEngine.bind(orch);
    orch.resolveEngine = async (_profileId: string) => engine;
  }

  return orch;
}

function sessionWithTaskCycle(sid: string): WorkflowSession {
  const s = createSession(sid, 'base');
  s.tasks.implementation = [{ id: 'task-1', path: 'src/task-1.ts', status: 'running' }];
  s.loopRuns['run-1'] = {
    id: 'run-1',
    taskId: 'task-1',
    listKey: 'implementation',
    ancestry: [],
    stage: 'mutation',
    status: 'running',
  };
  return s;
}

function sessionWithActiveOp(sid: string, callId: string, startedAt?: string): WorkflowSession {
  const s = sessionWithTaskCycle(sid);
  s.activeOperations[callId] = {
    callId,
    runId: 'run-1',
    taskId: 'task-1',
    agent: 'code',
    startedAt: startedAt ?? new Date().toISOString(),
    status: 'running',
  };
  return s;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('releaseInterruptedLock', () => {
  it('clears an activeOperation whose id is not in liveMutations', async () => {
    const log = mockLogFn();
    const orchestrator = await makeOrchestrator(createNoopEngine(), log);
    const session = sessionWithActiveOp(
      'test-stale',
      'stale-call-1',
      new Date(Date.now() - 60_000).toISOString()
    );
    await store.save(session);

    // beginMutation should release the stale lock
    await orchestrator.beginMutation(
      { sessionID: 'test-stale', callID: 'new-call-1' },
      { args: {} }
    );
    await drainQueue('test-stale');

    const reloaded = await store.load('test-stale');
    // active operation should have been cleared and replaced with the new one
    expect(reloaded?.activeOperations['stale-call-1']).toBeUndefined();
    expect(reloaded?.activeOperations['new-call-1']?.callId).toBe('new-call-1');
  });

  it('does NOT release when the same callID is retrying', async () => {
    const log = mockLogFn();
    const orchestrator = await makeOrchestrator(createNoopEngine(), log);
    const session = sessionWithActiveOp('test-retry', 'same-call');
    await store.save(session);

    await orchestrator.beginMutation(
      { sessionID: 'test-retry', callID: 'same-call' },
      { args: {} }
    );
    await drainQueue('test-retry');

    const reloaded = await store.load('test-retry');
    // Should keep the existing active operation — the same callID is retrying
    expect(reloaded?.activeOperations['same-call']?.callId).toBe('same-call');
  });

  it('releases expired mutation even when its callID is unknown', async () => {
    const log = mockLogFn();
    const orchestrator = await makeOrchestrator(createNoopEngine(), log);
    const oldDate = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago — expired
    const session = sessionWithActiveOp('test-expired', 'expired-call', oldDate);
    await store.save(session);

    await orchestrator.beginMutation(
      { sessionID: 'test-expired', callID: 'fresh-call' },
      { args: {} }
    );
    await drainQueue('test-expired');

    const reloaded = await store.load('test-expired');
    // Expired mutation should be released and new one started
    expect(reloaded?.activeOperations['expired-call']).toBeUndefined();
    expect(reloaded?.activeOperations['fresh-call']?.callId).toBe('fresh-call');
  });

  it('does NOT release mutations tracked in liveMutations', async () => {
    const log = mockLogFn();
    const orchestrator = await makeOrchestrator(createNoopEngine(), log);
    const session = sessionWithActiveOp('test-live', 'live-call');
    await store.save(session);

    // Starting a beginMutation with the same callID populates liveMutations.
    // Since the callID matches, releaseInterruptedLock won't clear it.
    await orchestrator.beginMutation({ sessionID: 'test-live', callID: 'live-call' }, { args: {} });
    await drainQueue('test-live');

    const reloaded = await store.load('test-live');
    expect(reloaded?.activeOperations['live-call']?.callId).toBe('live-call');
  });
});

describe('clearOnError', () => {
  it('clears activeOperation when callId is in liveMutations', async () => {
    const orchestrator = await makeOrchestrator(createNoopEngine());
    const session = sessionWithTaskCycle('test-clear');
    await store.save(session);

    // Start a mutation to populate liveMutations
    await orchestrator.beginMutation(
      { sessionID: 'test-clear', callID: 'clear-call' },
      { args: {} }
    );
    await drainQueue('test-clear');

    // Simulate error via clearOnError
    await orchestrator.clearOnError('clear-call');
    await drainQueue('test-clear');

    const reloaded = await store.load('test-clear');
    expect(reloaded?.activeOperations['clear-call']).toBeUndefined();
  });

  it('defers orphaned activeOperation to releaseInterruptedLock on next beginMutation', async () => {
    const orchestrator = await makeOrchestrator(createNoopEngine());
    // Save a session with an active operation that has no liveMutations entry
    const session = sessionWithActiveOp('test-orphan', 'orphan-call');
    await store.save(session);

    // clearOnError with the orphan callId — no longer scans all sessions.
    // The orphan is deferred to releaseInterruptedLock.
    await orchestrator.clearOnError('orphan-call');
    await drainQueue('test-orphan');

    // active operation should still be there — clearOnError defers to next beginMutation
    const reloadedAfter = await store.load('test-orphan');
    expect(reloadedAfter?.activeOperations['orphan-call']?.callId).toBe('orphan-call');

    // Next beginMutation should release the orphan via releaseInterruptedLock
    await orchestrator.beginMutation(
      { sessionID: 'test-orphan', callID: 'new-call' },
      { args: {} }
    );
    await drainQueue('test-orphan');

    const reloadedFinal = await store.load('test-orphan');
    expect(reloadedFinal?.activeOperations['orphan-call']).toBeUndefined();
    expect(reloadedFinal?.activeOperations['new-call']?.callId).toBe('new-call');
  });
});
