import { describe, expect, test } from 'bun:test';
import { projectRunView } from '../../src/domain/run-view.ts';
import type { WorkflowSnapshot } from '../../src/domain/workflow-model.ts';

function makeSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    formatVersion: 3,
    run: {
      id: 'run-1',
      revision: 1,
      title: 'test run',
      definitionDigest: 'abc123',
      rootScopeId: 'scope-1',
      input: {},
      status: 'active',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    scopes: {
      'scope-1': {
        id: 'scope-1',
        flowId: 'flow-1',
        parentExecutionId: null,
        branchKey: null,
        workItem: null,
        collection: null,
        input: {},
        cursorExecutionId: 'exec-1',
        status: 'active',
        terminalResultId: null,
      },
    },
    executions: {
      'exec-1': {
        id: 'exec-1',
        scopeId: 'scope-1',
        nodeId: 'node-1',
        occurrence: 1,
        predecessorExecutionId: null,
        currentAttemptId: 'attempt-1',
        childScopeIds: [],
        status: 'finished',
      },
    },
    attempts: {
      'attempt-1': {
        id: 'attempt-1',
        executionId: 'exec-1',
        attemptNumber: 1,
        status: 'completed',
        input: {},
        consumedResultIds: ['result-1'],
        subjects: [],
        allowedArtifactIds: [],
        baselineSnapshotId: null,
        resultId: 'result-1',
        createdAt: '2025-01-01T00:00:00Z',
        finishedAt: '2025-01-01T00:00:10Z',
      },
    },
    results: {},
    decisions: {},
    retryBudgets: {},
    resourceClaims: {},
    validations: {},
    transitions: {},
    appliedCommands: {},
    host: { sessions: {}, bindings: {} },
    ...overrides,
  };
}

describe('projectRunView', () => {
  test('маппит базовые поля run', () => {
    const view = projectRunView(makeSnapshot());
    expect(view.runId).toBe('run-1');
    expect(view.revision).toBe(1);
    expect(view.title).toBe('test run');
    expect(view.status).toBe('active');
    expect(view.definitionDigest).toBe('abc123');
    expect(view.createdAt).toBe('2025-01-01T00:00:00Z');
    expect(view.updatedAt).toBe('2025-01-01T00:00:00Z');
  });

  test('маппит scopes', () => {
    const view = projectRunView(makeSnapshot());
    expect(view.scopes).toHaveLength(1);
    expect(view.scopes[0].id).toBe('scope-1');
    expect(view.scopes[0].flowId).toBe('flow-1');
    expect(view.scopes[0].status).toBe('active');
    expect(view.scopes[0].cursorExecutionId).toBe('exec-1');
    expect(view.scopes[0].parentExecutionId).toBeNull();
  });

  test('маппит executions', () => {
    const view = projectRunView(makeSnapshot());
    expect(view.executions).toHaveLength(1);
    expect(view.executions[0].id).toBe('exec-1');
    expect(view.executions[0].scopeId).toBe('scope-1');
    expect(view.executions[0].nodeId).toBe('node-1');
    expect(view.executions[0].occurrence).toBe(1);
    expect(view.executions[0].status).toBe('finished');
    expect(view.executions[0].currentAttemptId).toBe('attempt-1');
  });

  test('маппит attempts', () => {
    const view = projectRunView(makeSnapshot());
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0].id).toBe('attempt-1');
    expect(view.attempts[0].attemptNumber).toBe(1);
    expect(view.attempts[0].status).toBe('completed');
    expect(view.attempts[0].resultId).toBe('result-1');
    expect(view.attempts[0].createdAt).toBe('2025-01-01T00:00:00Z');
    expect(view.attempts[0].finishedAt).toBe('2025-01-01T00:00:10Z');
  });

  test('маппит decisions с resolution', () => {
    const view = projectRunView(
      makeSnapshot({
        decisions: {
          'dec-1': {
            id: 'dec-1',
            owner: { scopeId: 'scope-1', executionId: 'exec-1', attemptId: 'attempt-1' },
            purpose: 'step',
            subjects: [],
            policy: { authority: 'human', allowedActors: ['user'], outcomes: ['approve'], onInvalidated: 'retry', onExpired: 'retry' },
            status: 'resolved',
            resolution: {
              outcome: 'approved',
              parameters: {},
              resolverId: 'user',
              authority: 'human',
              revision: 2,
            },
          },
        },
      })
    );
    expect(view.decisions).toHaveLength(1);
    expect(view.decisions[0].purpose).toBe('step');
    expect(view.decisions[0].status).toBe('resolved');
    expect(view.decisions[0].outcome).toBe('approved');
  });

  test('маппит decisions без resolution — outcome null', () => {
    const view = projectRunView(
      makeSnapshot({
        decisions: {
          'dec-1': {
            id: 'dec-1',
            owner: { scopeId: 'scope-1', executionId: 'exec-1', attemptId: 'attempt-1' },
            purpose: 'step',
            subjects: [],
            policy: { authority: 'human', allowedActors: ['user'], outcomes: ['approve'], onInvalidated: 'retry', onExpired: 'retry' },
            status: 'pending',
            resolution: null,
          },
        },
      })
    );
    expect(view.decisions).toHaveLength(1);
    expect(view.decisions[0].status).toBe('pending');
    expect(view.decisions[0].outcome).toBeNull();
  });

  test('маппит transitions с существующим результатом', () => {
    const view = projectRunView(
      makeSnapshot({
        results: {
          'result-1': {
            id: 'result-1',
            version: '2',
            execution: { scopeId: 'scope-1', executionId: 'exec-1', attemptId: 'attempt-1' },
            outcome: 'passed',
            summary: 'ok',
            outputs: {},
            subjects: [],
            evidence: [],
            checks: [],
            authority: 'assertion',
            producerId: 'test',
            recordedRevision: 2,
          },
        },
        transitions: {
          't-1': {
            id: 't-1',
            scopeId: 'scope-1',
            transitionId: 'trans-1',
            fromExecutionId: 'exec-1',
            toExecutionId: 'exec-2',
            consumedResultId: 'result-1',
            recordedRevision: 2,
          },
        },
      })
    );
    expect(view.transitions).toHaveLength(1);
    expect(view.transitions[0].outcome).toBe('passed');
  });

  test('маппит transitions без результата — outcome unknown', () => {
    const view = projectRunView(
      makeSnapshot({
        transitions: {
          't-1': {
            id: 't-1',
            scopeId: 'scope-1',
            transitionId: 'trans-1',
            fromExecutionId: 'exec-1',
            toExecutionId: 'exec-2',
            consumedResultId: 'missing-result',
            recordedRevision: 2,
          },
        },
      })
    );
    expect(view.transitions).toHaveLength(1);
    expect(view.transitions[0].outcome).toBe('unknown');
  });

  test('pending: pending-решение добавляется', () => {
    const view = projectRunView(
      makeSnapshot({
        decisions: {
          'dec-1': {
            id: 'dec-1',
            owner: { scopeId: 'scope-1', executionId: 'exec-1', attemptId: 'attempt-1' },
            purpose: 'step',
            subjects: [{ id: 'exec-2', version: '1' }],
            policy: { authority: 'human', allowedActors: ['user'], outcomes: ['approve'], onInvalidated: 'retry', onExpired: 'retry' },
            status: 'pending',
            resolution: null,
          },
        },
      })
    );
    expect(view.pending.length).toBeGreaterThanOrEqual(1);
    const decItem = view.pending.find((p) => p.kind === 'decision');
    expect(decItem).toBeDefined();
    expect(decItem!.reason).toContain('step');
  });

  test('pending: resolved-решение не добавляется', () => {
    const view = projectRunView(
      makeSnapshot({
        decisions: {
          'dec-1': {
            id: 'dec-1',
            owner: { scopeId: 'scope-1', executionId: 'exec-1', attemptId: 'attempt-1' },
            purpose: 'step',
            subjects: [],
            policy: { authority: 'human', allowedActors: ['user'], outcomes: ['approve'], onInvalidated: 'retry', onExpired: 'retry' },
            status: 'resolved',
            resolution: { outcome: 'approved', parameters: {}, resolverId: 'user', authority: 'human', revision: 2 },
          },
        },
      })
    );
    expect(view.pending.filter((p) => p.kind === 'decision')).toHaveLength(0);
  });

  test('pending: ready-выполнение добавляется', () => {
    const view = projectRunView(
      makeSnapshot({
        executions: {
          'exec-ready': {
            id: 'exec-ready',
            scopeId: 'scope-1',
            nodeId: 'node-1',
            occurrence: 1,
            predecessorExecutionId: null,
            currentAttemptId: 'attempt-x',
            childScopeIds: [],
            status: 'ready',
          },
        },
      })
    );
    expect(view.pending.filter((p) => p.kind === 'execution')).toHaveLength(1);
  });

  test('pending: waiting-выполнение добавляется', () => {
    const view = projectRunView(
      makeSnapshot({
        executions: {
          'exec-waiting': {
            id: 'exec-waiting',
            scopeId: 'scope-1',
            nodeId: 'node-1',
            occurrence: 1,
            predecessorExecutionId: null,
            currentAttemptId: 'attempt-x',
            childScopeIds: [],
            status: 'waiting',
          },
        },
      })
    );
    expect(view.pending.filter((p) => p.kind === 'execution')).toHaveLength(1);
  });

  test('pending: finished-выполнение не добавляется', () => {
    const view = projectRunView(
      makeSnapshot({
        executions: {
          'exec-finished': {
            id: 'exec-finished',
            scopeId: 'scope-1',
            nodeId: 'node-1',
            occurrence: 1,
            predecessorExecutionId: null,
            currentAttemptId: 'attempt-x',
            childScopeIds: [],
            status: 'finished',
          },
        },
      })
    );
    expect(view.pending.filter((p) => p.kind === 'execution')).toHaveLength(0);
  });

  test('pending: пустой список когда нет pending-решений и все execution завершены', () => {
    const view = projectRunView(makeSnapshot());
    expect(view.pending).toHaveLength(0);
  });

  test('маппит subjects в decisions', () => {
    const view = projectRunView(
      makeSnapshot({
        decisions: {
          'dec-1': {
            id: 'dec-1',
            owner: { scopeId: 'scope-1', executionId: 'exec-1', attemptId: 'attempt-1' },
            purpose: 'step',
            subjects: [{ id: 'exec-2', version: '1' }],
            policy: { authority: 'human', allowedActors: ['user'], outcomes: ['approve'], onInvalidated: 'retry', onExpired: 'retry' },
            status: 'pending',
            resolution: null,
          },
        },
      })
    );
    expect(view.decisions[0].subjects).toEqual([{ id: 'exec-2', version: '1' }]);
  });

  test('маппит несколько scopes', () => {
    const view = projectRunView(
      makeSnapshot({
        scopes: {
          'scope-1': {
            id: 'scope-1',
            flowId: 'flow-1',
            parentExecutionId: null,
            branchKey: null,
            workItem: null,
            collection: null,
            input: {},
            cursorExecutionId: 'exec-1',
            status: 'active',
            terminalResultId: null,
          },
          'scope-2': {
            id: 'scope-2',
            flowId: 'flow-2',
            parentExecutionId: 'exec-1',
            branchKey: null,
            workItem: null,
            collection: null,
            input: {},
            cursorExecutionId: 'exec-2',
            status: 'succeeded',
            terminalResultId: null,
          },
        },
      })
    );
    expect(view.scopes).toHaveLength(2);
    expect(view.scopes[1].parentExecutionId).toBe('exec-1');
    expect(view.scopes[1].status).toBe('succeeded');
  });
});
