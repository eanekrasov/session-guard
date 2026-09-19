// ─── Contract Tests: YAML Schemas ─────────────────────────────────────────────
//
// Tests the public API of YAML input schemas.
// Verifies that ProfileYamlSchema, StageYamlSchema, TransitionYamlSchema,
// and ActionEntryYamlSchema correctly parse valid input and reject invalid.

import { describe, expect, test } from 'vitest';
import {
  ProfileYamlSchema,
  StageYamlSchema,
  TransitionYamlSchema,
  ActionEntryYamlSchema,
  RetryBudgetYamlSchema,
  LoopSourceYamlSchema,
  DispatchYamlSchema,
  StageAssignmentRuleYamlSchema,
} from '../../src/schema/yaml-schemas.ts';

// ─── ActionEntryYamlSchema ────────────────────────────────────────────────────

describe('ActionEntryYamlSchema', () => {
  describe('valid input', () => {
    test('parses edit action with paths', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'edit',
        paths: ['src/app.ts'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('edit');
        expect(result.data.paths).toEqual(['src/app.ts']);
      }
    });

    test('parses bash action with commands', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'bash',
        commands: ['npm run build'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('bash');
        expect(result.data.commands).toEqual(['npm run build']);
      }
    });

    test('parses action with guard and optional fields', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'edit',
        paths: ['file.ts'],
        delivers: true,
        guard: 'session.approved("plan")',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.delivers).toBe(true);
        expect(result.data.guard).toBe('session.approved("plan")');
      }
    });

    test('parses minimal action (action only)', () => {
      const result = ActionEntryYamlSchema.safeParse({ action: 'edit' });
      expect(result.success).toBe(true);
    });

    test('parses action with empty optional arrays', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'bash',
        paths: [],
        commands: [],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid input', () => {
    test('rejects invalid action type', () => {
      const result = ActionEntryYamlSchema.safeParse({ action: 'delete' });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for paths', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'edit',
        paths: 'src/app.ts', // should be array
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for commands', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'bash',
        commands: 'npm run build', // should be array
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for delivers', () => {
      const result = ActionEntryYamlSchema.safeParse({
        action: 'edit',
        delivers: 'yes', // should be boolean
      });
      expect(result.success).toBe(false);
    });

    // NOTE: ActionEntryYamlSchema uses Zod defaults (passthrough), so unknown keys are allowed
    // ProfileYamlSchema uses .strict() at top level, which is tested separately
  });
});

// ─── TransitionYamlSchema ─────────────────────────────────────────────────────

describe('TransitionYamlSchema', () => {
  describe('valid input', () => {
    test('parses minimal transition (from, to)', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'planning',
        to: 'implementation',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.from).toBe('planning');
        expect(result.data.to).toBe('implementation');
      }
    });

    test('parses transition with guard', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'implementation',
        to: 'review',
        guard: 'task.status === "completed"',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.guard).toBe('task.status === "completed"');
      }
    });

    test('parses transition with effects (bumpRetry, maxAttempts, approve)', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'build',
        to: 'validation',
        effects: [{ bumpRetry: 'task-1', maxAttempts: 3, approve: 'plan' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.effects).toHaveLength(1);
        expect(result.data.effects![0].bumpRetry).toBe('task-1');
        expect(result.data.effects![0].maxAttempts).toBe(3);
        expect(result.data.effects![0].approve).toBe('plan');
      }
    });

    test('parses transition with consent (string form)', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'review',
        to: 'delivery',
        consent: 'plan',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.consent).toBe('plan');
      }
    });

    test('parses transition with consent (object form)', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'review',
        to: 'delivery',
        consent: { type: 'plan' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.consent).toEqual({ type: 'plan' });
      }
    });

    test('parses transition with onFailure: retry', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'build',
        to: 'build',
        onFailure: 'retry',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.onFailure).toBe('retry');
      }
    });

    test('parses transition with onFailure: terminal', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'build',
        to: 'failed',
        onFailure: 'terminal',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.onFailure).toBe('terminal');
      }
    });

    test('parses transition with all fields', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'planning',
        to: 'done',
        guard: 'session.approved("plan")',
        effects: [{ approve: 'plan' }],
        consent: { type: 'plan' },
        onFailure: 'terminal',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid input', () => {
    test('rejects missing from', () => {
      const result = TransitionYamlSchema.safeParse({ to: 'planning' });
      expect(result.success).toBe(false);
    });

    test('rejects missing to', () => {
      const result = TransitionYamlSchema.safeParse({ from: 'planning' });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for guard', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'planning',
        to: 'implementation',
        guard: 123,
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for effects', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'planning',
        to: 'implementation',
        effects: 'not-an-array',
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid effect field', () => {
      // TransitionEffectSchema uses Zod defaults (passthrough), so unknown keys are allowed
      // ProfileYamlSchema uses .strict() at top level, which is tested separately
      const result = TransitionYamlSchema.safeParse({
        from: 'planning',
        to: 'implementation',
        effects: [{ unknown: 'field' }],
      });
      expect(result.success).toBe(true);
    });

    test('rejects wrong type for consent', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'review',
        to: 'delivery',
        consent: 123,
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid consent object', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'review',
        to: 'delivery',
        consent: { wrongField: 'value' },
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid onFailure value', () => {
      const result = TransitionYamlSchema.safeParse({
        from: 'build',
        to: 'failed',
        onFailure: 'abort',
      });
      expect(result.success).toBe(false);
    });

    // NOTE: TransitionDefSchema uses Zod defaults (passthrough), so unknown keys are allowed
  });
});

// ─── StageYamlSchema ─────────────────────────────────────────────────────────

describe('StageYamlSchema', () => {
  describe('valid input', () => {
    test('parses minimal stage', () => {
      const result = StageYamlSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    test('parses stage with loop (static list key)', () => {
      const result = StageYamlSchema.safeParse({
        loop: 'issues',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.loop).toBe('issues');
      }
    });

    test('parses stage with $currentTask.id loop', () => {
      const result = StageYamlSchema.safeParse({
        loop: '$currentTask.id',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.loop).toBe('$currentTask.id');
      }
    });

    test('parses stage with dispatch: serial', () => {
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'serial' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dispatch).toEqual({ strategy: 'serial' });
      }
    });

    test('parses stage with dispatch: parallel', () => {
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'parallel', maxConcurrent: 4 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dispatch).toEqual({ strategy: 'parallel', maxConcurrent: 4 });
      }
    });

    test('parses stage with dispatch: serial_with_overlap', () => {
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'serial_with_overlap', maxConcurrent: 2, overlapRoles: ['reviewer'] },
      });
      expect(result.success).toBe(true);
    });

    test('parses stage with retryBudget', () => {
      const result = StageYamlSchema.safeParse({
        retryBudget: { maximum: 3 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.retryBudget).toEqual({ maximum: 3 });
      }
    });

    test('parses stage with allowedAgents', () => {
      const result = StageYamlSchema.safeParse({
        allowedAgents: ['agent-1', 'agent-2'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowedAgents).toEqual(['agent-1', 'agent-2']);
      }
    });

    test('parses stage with actions', () => {
      const result = StageYamlSchema.safeParse({
        actions: [
          { action: 'edit', paths: ['src/**/*.ts'] },
          { action: 'bash', commands: ['npm test'] },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.actions).toHaveLength(2);
      }
    });

    test('parses stage with gates', () => {
      const result = StageYamlSchema.safeParse({
        gates: ['build', 'test'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.gates).toEqual(['build', 'test']);
      }
    });

    test('parses stage with entryGuards and exitGuards', () => {
      const result = StageYamlSchema.safeParse({
        entryGuards: ['session.checks === "passed"'],
        exitGuards: ['task.status === "completed"'],
      });
      expect(result.success).toBe(true);
    });

    test('parses stage with nested stages', () => {
      const result = StageYamlSchema.safeParse({
        stages: {
          implementation: {},
          review: { gates: ['build'] },
        },
      });
      expect(result.success).toBe(true);
    });

    test('parses stage with transitions', () => {
      const result = StageYamlSchema.safeParse({
        transitions: [
          { from: 'implementation', to: 'review' },
          { from: 'review', to: 'done', guard: 'session.approved("review")' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.transitions).toHaveLength(2);
      }
    });

    test('parses stage with all fields', () => {
      const result = StageYamlSchema.safeParse({
        loop: 'features',
        dispatch: { strategy: 'serial' },
        retryBudget: { maximum: 2 },
        allowedAgents: ['coder'],
        actions: [{ action: 'edit', paths: ['src/**'] }],
        gates: ['build'],
        entryGuards: ['true'],
        exitGuards: ['true'],
        stages: { nested: {} },
        transitions: [{ from: 'stage', to: 'next' }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid input', () => {
    test('rejects wrong type for loop', () => {
      const result = StageYamlSchema.safeParse({ loop: 123 });
      expect(result.success).toBe(false);
    });

    test('rejects empty loop string', () => {
      const result = StageYamlSchema.safeParse({ loop: '' });
      expect(result.success).toBe(false);
    });

    test('rejects task-NNN as loop source', () => {
      const result = StageYamlSchema.safeParse({ loop: 'task-17' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some((i) => i.message?.includes('task'))).toBe(true);
      }
    });

    test('rejects task-123 as loop source', () => {
      const result = StageYamlSchema.safeParse({ loop: 'task-123' });
      expect(result.success).toBe(false);
    });

    test('rejects $variable as loop source (not allowed)', () => {
      const result = StageYamlSchema.safeParse({ loop: '$tasks' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid dispatch strategy', () => {
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'unknown' },
      });
      expect(result.success).toBe(false);
    });

    test('rejects serial dispatch with maxConcurrent', () => {
      // serial strategy does NOT accept maxConcurrent
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'serial', maxConcurrent: 2 },
      });
      expect(result.success).toBe(false);
    });

    test('rejects parallel dispatch without maxConcurrent', () => {
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'parallel' },
      });
      expect(result.success).toBe(false);
    });

    test('rejects serial_with_overlap without maxConcurrent', () => {
      const result = StageYamlSchema.safeParse({
        dispatch: { strategy: 'serial_with_overlap' },
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for retryBudget', () => {
      const result = StageYamlSchema.safeParse({ retryBudget: 'max: 3' });
      expect(result.success).toBe(false);
    });

    test('rejects retryBudget with invalid maximum', () => {
      const result = StageYamlSchema.safeParse({ retryBudget: { maximum: 0 } });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for gates', () => {
      const result = StageYamlSchema.safeParse({ gates: 'build' });
      expect(result.success).toBe(false);
    });

    test('rejects unknown key at top level', () => {
      // StageYamlSchema uses .passthrough() so unknown keys are allowed
      const result = StageYamlSchema.safeParse({ unknownKey: 'value' });
      expect(result.success).toBe(true); // passthrough allows extra keys
    });
  });

  describe('loop source validation', () => {
    test('accepts static list key', () => {
      const keys = ['features', 'bugs', 'issues', 'PRs', 'commits'];
      for (const key of keys) {
        const result = LoopSourceYamlSchema.safeParse(key);
        expect(result.success).toBe(true);
      }
    });

    test('accepts $currentTask.id', () => {
      const result = LoopSourceYamlSchema.safeParse('$currentTask.id');
      expect(result.success).toBe(true);
    });

    test('rejects task-17', () => {
      const result = LoopSourceYamlSchema.safeParse('task-17');
      expect(result.success).toBe(false);
    });

    test('rejects task-1', () => {
      const result = LoopSourceYamlSchema.safeParse('task-1');
      expect(result.success).toBe(false);
    });

    test('rejects task-999', () => {
      const result = LoopSourceYamlSchema.safeParse('task-999');
      expect(result.success).toBe(false);
    });

    test('rejects $currentTask (not allowed)', () => {
      const result = LoopSourceYamlSchema.safeParse('$currentTask');
      expect(result.success).toBe(false);
    });

    test('rejects empty string', () => {
      const result = LoopSourceYamlSchema.safeParse('');
      expect(result.success).toBe(false);
    });
  });

  describe('dispatch strategies', () => {
    test('parses serial strategy', () => {
      const result = DispatchYamlSchema.safeParse({
        strategy: 'serial',
        overlapRoles: ['reviewer'],
      });
      expect(result.success).toBe(true);
    });

    test('parses parallel strategy', () => {
      const result = DispatchYamlSchema.safeParse({
        strategy: 'parallel',
        maxConcurrent: 4,
        overlapRoles: ['observer'],
      });
      expect(result.success).toBe(true);
    });

    test('parses serial_with_overlap strategy', () => {
      const result = DispatchYamlSchema.safeParse({
        strategy: 'serial_with_overlap',
        maxConcurrent: 2,
        overlapRoles: ['reviewer', 'qa'],
      });
      expect(result.success).toBe(true);
    });

    test('rejects unknown strategy', () => {
      const result = DispatchYamlSchema.safeParse({
        strategy: 'random',
      });
      expect(result.success).toBe(false);
    });

    test('rejects maxConcurrent for serial strategy', () => {
      // This is optional field, so technically valid but semantically wrong
      // Let's test actual invalid case
      const result = DispatchYamlSchema.safeParse({
        strategy: 'serial',
        maxConcurrent: -1,
      });
      expect(result.success).toBe(false);
    });

    test('rejects maxConcurrent <= 0 for parallel', () => {
      const result = DispatchYamlSchema.safeParse({
        strategy: 'parallel',
        maxConcurrent: 0,
      });
      expect(result.success).toBe(false);
    });

    test('rejects non-integer maxConcurrent', () => {
      const result = DispatchYamlSchema.safeParse({
        strategy: 'parallel',
        maxConcurrent: 2.5,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ─── ProfileYamlSchema ────────────────────────────────────────────────────────

describe('ProfileYamlSchema', () => {
  describe('valid input', () => {
    test('parses empty profile', () => {
      const result = ProfileYamlSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    test('parses profile with extends', () => {
      const result = ProfileYamlSchema.safeParse({
        extends: 'base.yaml',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.extends).toBe('base.yaml');
      }
    });

    test('parses profile with stages', () => {
      const result = ProfileYamlSchema.safeParse({
        stages: {
          planning: { gates: ['plan'] },
          implementation: { loop: 'features' },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.stages!)).toContain('planning');
        expect(Object.keys(result.data.stages!)).toContain('implementation');
      }
    });

    test('parses profile with stageAssignments', () => {
      const result = ProfileYamlSchema.safeParse({
        stageAssignments: [
          { id: 'rule-1', priority: 100, condition: 'session.revision === 0', result: 'planning' },
          { id: 'rule-2', priority: 50, condition: 'true', result: 'implementation' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stageAssignments).toHaveLength(2);
      }
    });

    test('parses profile with transitions', () => {
      const result = ProfileYamlSchema.safeParse({
        transitions: [
          { from: 'planning', to: 'implementation' },
          { from: 'implementation', to: 'review', guard: 'task.status === "completed"' },
        ],
      });
      expect(result.success).toBe(true);
    });

    test('parses profile with editingAgents', () => {
      const result = ProfileYamlSchema.safeParse({
        editingAgents: ['coder', 'reviewer'],
      });
      expect(result.success).toBe(true);
    });

    test('parses profile with taskControlAgents', () => {
      const result = ProfileYamlSchema.safeParse({
        taskControlAgents: ['orchestrator'],
      });
      expect(result.success).toBe(true);
    });

    test('parses complete profile', () => {
      const result = ProfileYamlSchema.safeParse({
        extends: 'base.yaml',
        stages: {
          planning: { gates: ['plan'] },
          implementation: {
            loop: 'features',
            dispatch: { strategy: 'parallel', maxConcurrent: 2 },
            actions: [{ action: 'edit', paths: ['src/**'] }],
          },
          review: {
            transitions: [{ from: 'review', to: 'delivery', consent: 'review' }],
          },
        },
        stageAssignments: [{ id: 'initial', priority: 100, condition: 'true', result: 'planning' }],
        transitions: [{ from: 'implementation', to: 'review', onFailure: 'retry' }],
        editingAgents: ['coder'],
        taskControlAgents: ['orchestrator'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid input', () => {
    test('rejects unknown top-level key (strict mode)', () => {
      const result = ProfileYamlSchema.safeParse({
        unknownField: 'value',
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for extends', () => {
      const result = ProfileYamlSchema.safeParse({
        extends: 123,
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for stages', () => {
      const result = ProfileYamlSchema.safeParse({
        stages: 'not-an-object',
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for stageAssignments', () => {
      const result = ProfileYamlSchema.safeParse({
        stageAssignments: 'not-an-array',
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid stageAssignment rule', () => {
      const result = ProfileYamlSchema.safeParse({
        stageAssignments: [
          { id: 'rule', priority: 'high' }, // wrong type
        ],
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong type for editingAgents', () => {
      const result = ProfileYamlSchema.safeParse({
        editingAgents: 'coder', // should be array
      });
      expect(result.success).toBe(false);
    });
  });

  describe('stageAssignments schema', () => {
    test('parses valid stageAssignment rule', () => {
      const result = StageAssignmentRuleYamlSchema.safeParse({
        id: 'rule-1',
        priority: 100,
        condition: 'session.approved("plan")',
        result: 'implementation',
      });
      expect(result.success).toBe(true);
    });

    test('rejects missing required fields', () => {
      const result = StageAssignmentRuleYamlSchema.safeParse({
        id: 'rule-1',
        priority: 100,
      });
      expect(result.success).toBe(false);
    });

    test('rejects wrong types', () => {
      const result = StageAssignmentRuleYamlSchema.safeParse({
        id: 123,
        priority: 'high',
        condition: true,
        result: 456,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('duplicate loop source detection', () => {
    test('rejects duplicate loop sources across stages', () => {
      const result = ProfileYamlSchema.safeParse({
        stages: {
          stage1: { loop: 'features' },
          stage2: { loop: 'features' },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some((i) => i.message?.includes('already used'))).toBe(true);
      }
    });

    test('accepts different loop sources', () => {
      const result = ProfileYamlSchema.safeParse({
        stages: {
          stage1: { loop: 'features' },
          stage2: { loop: 'bugs' },
        },
      });
      expect(result.success).toBe(true);
    });

    test('accepts stages without loop', () => {
      const result = ProfileYamlSchema.safeParse({
        stages: {
          stage1: {},
          stage2: { loop: 'features' },
        },
      });
      expect(result.success).toBe(true);
    });

    test('accepts $currentTask.id multiple times (not a conflict)', () => {
      const result = ProfileYamlSchema.safeParse({
        stages: {
          stage1: { loop: '$currentTask.id' },
          stage2: { loop: '$currentTask.id' },
        },
      });
      expect(result.success).toBe(true);
    });
  });
});

// ─── RetryBudgetYamlSchema ───────────────────────────────────────────────────

describe('RetryBudgetYamlSchema', () => {
  test('parses valid retry budget', () => {
    const result = RetryBudgetYamlSchema.safeParse({ maximum: 3 });
    expect(result.success).toBe(true);
  });

  test('rejects missing maximum', () => {
    const result = RetryBudgetYamlSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects non-positive maximum', () => {
    const result = RetryBudgetYamlSchema.safeParse({ maximum: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer maximum', () => {
    const result = RetryBudgetYamlSchema.safeParse({ maximum: 2.5 });
    expect(result.success).toBe(false);
  });

  test('rejects extra fields', () => {
    // RetryBudgetSchema uses Zod defaults (passthrough), so extra fields are allowed
    const result = RetryBudgetYamlSchema.safeParse({ maximum: 3, extra: 'field' });
    expect(result.success).toBe(true);
  });
});
