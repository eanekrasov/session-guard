import { describe, expect, test } from 'bun:test';

import {
  assertParityReportEntryInvariant,
  assertScenarioResultInvariant,
  createBlockedResult,
  createNotRunParityEntry,
  type PluginObservation,
  type ScenarioDefinition,
} from '../src/host/types.ts';

const baseResult = {
  id: 'create',
  title: 'Create workflow',
  hostKind: 'v1' as const,
  attempts: 1,
  durationMs: 12,
  evidence: 'durable state observed',
};

describe('normalized smoke contracts', () => {
  test('keeps blocked reasons closed and creates a reason-bearing result', () => {
    const result = createBlockedResult({
      ...baseResult,
      blockedReason: 'adapter_contract_mismatch',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      blockedReason: 'adapter_contract_mismatch',
    });
    expect(() =>
      assertScenarioResultInvariant({ ...baseResult, status: 'blocked' } as never)
    ).toThrow('blocked scenario result requires blockedReason');
  });

  test('requires a reason for every not-run parity entry', () => {
    const entry = createNotRunParityEntry({
      scenarioId: 'commit-gate',
      evidence: 'migration is pending',
      notRunReason: 'pending-migration',
    });

    expect(entry).toMatchObject({ parity: 'not-run', notRunReason: 'pending-migration' });
    expect(() =>
      assertParityReportEntryInvariant({
        scenarioId: 'commit-gate',
        parity: 'not-run',
        evidence: 'missing reason',
      })
    ).toThrow('not-run parity entry requires notRunReason');
  });

  test('models migrated and pending registry entries with different step requirements', () => {
    const step = {
      instruction: 'Call workflow-create',
      mutation: 'read-only' as const,
      retry: 'none' as const,
      expect: () => true as const,
    };
    const migrated: ScenarioDefinition = {
      id: 'create',
      title: 'Create workflow',
      migrationState: 'migrated',
      steps: [step],
    };
    const pending: ScenarioDefinition = {
      id: 'commit-gate',
      title: 'Commit gate',
      migrationState: 'pending',
    };

    expect(migrated.steps).toHaveLength(1);
    expect(pending.steps).toBeUndefined();
  });

  test('keeps plugin evidence structured and tied to normalized tool calls', () => {
    const evidence: PluginObservation = {
      loaded: true,
      observedPluginTools: ['workflow-list'],
      invokedTools: [
        { name: 'workflow-list', status: 'completed', output: '{"profilesDir":"smoke"}' },
      ],
      hostOperation: 'real-host',
      result: 'success',
    };

    const promptResult = {
      turn: {
        status: 'completed' as const,
        transcript: 'workflow-list completed',
        parts: [],
        toolCalls: evidence.invokedTools,
      },
      workflowState: null,
      pluginEvidence: evidence,
    };

    expect(evidence).toEqual({
      loaded: true,
      observedPluginTools: ['workflow-list'],
      invokedTools: [
        { name: 'workflow-list', status: 'completed', output: '{"profilesDir":"smoke"}' },
      ],
      hostOperation: 'real-host',
      result: 'success',
    });
    expect(promptResult.pluginEvidence.hostOperation).toBe('real-host');
  });
});
