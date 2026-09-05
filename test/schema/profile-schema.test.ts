import { describe, it, expect } from 'vitest';

import { ProfileSchemaSchema } from '../../src/schema/profile-schema.ts';

describe('ProfileSchemaSchema', () => {
  describe('actionGuards', () => {
    it('accepts actionGuards with string expression values', () => {
      const input = {
        actionGuards: {
          beginMutation: "session.granted('plan')",
        },
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.actionGuards).toBeDefined();
      expect(result.actionGuards!.beginMutation).toBe("session.granted('plan')");
    });

    it('accepts actionGuards with multiple entries', () => {
      const input = {
        actionGuards: {
          beginMutation: "session.granted('plan')",
          completeTask: 'session.tasks.implementation.length > 0',
        },
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.actionGuards!.beginMutation).toBe("session.granted('plan')");
      expect(result.actionGuards!.completeTask).toBe('session.tasks.implementation.length > 0');
    });

    it('accepts schema without actionGuards', () => {
      const input = {
        phases: {
          PLANNING: {},
        },
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.actionGuards).toBeUndefined();
      expect(result.phases).toBeDefined();
    });
  });

  describe('exitGuards', () => {
    it('accepts multiple exitGuards with logical operators', () => {
      const input = {
        phases: {
          PLANNING: {
            dispatch: { strategy: 'serial' },
            stages: [
              {
                id: 'plan',
                exitGuards: [
                  'session.activeMutation?.outputReady == true',
                  "session.testStatus['build'] == 'pass'",
                ],
              },
            ],
          },
        },
      };

      const result = ProfileSchemaSchema.parse(input);
      const stages = result.phases!.PLANNING.stages!;

      expect(stages[0].exitGuards).toEqual([
        'session.activeMutation?.outputReady == true',
        "session.testStatus['build'] == 'pass'",
      ]);
    });
  });

  describe('task cycles', () => {
    it('parses declarative loop metadata', () => {
      const parsed = ProfileSchemaSchema.parse({
        phases: {
          execution: {
            loop: 'implementation',
            retryBudget: { maximum: 3 },
            dispatch: { strategy: 'parallel', maxConcurrent: 3 },
            stages: [{ id: 'dev' }, { id: 'review' }, { id: 'qa' }],
            exitGuards: ['allTasksCompleted()'],
          },
        },
        transitions: [{ from: 'execution', to: 'done', onFailure: 'terminal' }],
      });

      expect(parsed.phases!.execution.loop).toBe('implementation');
      expect(parsed.phases!.execution.retryBudget!.maximum).toBe(3);

      expect(() =>
        ProfileSchemaSchema.parse({
          phases: { execution: { loop: 'implementation', retryBudget: { maximum: 0 } } },
        })
      ).toThrow();
      expect(parsed.phases!.execution.exitGuards).toEqual(['allTasksCompleted()']);
      expect(parsed.transitions![0].onFailure).toBe('terminal');
    });

    it('allows serial dispatch only without maxConcurrent', () => {
      expect(
        ProfileSchemaSchema.safeParse({
          phases: { execution: { dispatch: { strategy: 'serial' } } },
        }).success
      ).toBe(true);

      expect(
        ProfileSchemaSchema.safeParse({
          phases: { execution: { dispatch: { strategy: 'serial', maxConcurrent: 1 } } },
        }).success
      ).toBe(false);
    });

    it.each(['parallel', 'serial_with_overlap'])(
      'requires a positive integer maxConcurrent for %s dispatch',
      (strategy) => {
        for (const maxConcurrent of [undefined, 0, 1.5]) {
          expect(
            ProfileSchemaSchema.safeParse({
              phases: { execution: { dispatch: { strategy, maxConcurrent } } },
            }).success
          ).toBe(false);
        }

        expect(
          ProfileSchemaSchema.safeParse({
            phases: { execution: { dispatch: { strategy, maxConcurrent: 2 } } },
          }).success
        ).toBe(true);
      }
    );

    it('rejects unknown dispatch strategies', () => {
      expect(
        ProfileSchemaSchema.safeParse({
          phases: { execution: { dispatch: { strategy: 'unordered' } } },
        }).success
      ).toBe(false);
    });

    it('rejects literal task instance loop keys', () => {
      expect(
        ProfileSchemaSchema.safeParse({ phases: { execution: { loop: 'task-17' } } }).success
      ).toBe(false);
    });

    it('allows $currentTask.id as a loop source', () => {
      expect(
        ProfileSchemaSchema.safeParse({
          phases: { execution: { loop: '$currentTask.id' } },
        }).success
      ).toBe(true);
    });

    it('allows each loop source in only one phase', () => {
      const result = ProfileSchemaSchema.safeParse({
        phases: {
          implementation: { loop: 'implementation' },
          verification: { loop: 'implementation' },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['phases', 'verification', 'loop']);
      }
    });
  });

  describe('transitions', () => {
    it('accepts transitions with guard, from, to, kind fields', () => {
      const input = {
        transitions: [
          {
            from: 'PLANNING',
            to: 'EXECUTION',
            guard: "session.granted('plan')",
            kind: 'auto',
          },
        ],
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.transitions).toHaveLength(1);
      expect(result.transitions![0].from).toBe('PLANNING');
      expect(result.transitions![0].to).toBe('EXECUTION');
      expect(result.transitions![0].guard).toBe("session.granted('plan')");
      expect(result.transitions![0].kind).toBe('auto');
    });

    it('accepts transition without optional guard and kind', () => {
      const input = {
        transitions: [{ from: 'PLANNING', to: 'EXECUTION' }],
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.transitions![0].guard).toBeUndefined();
      expect(result.transitions![0].kind).toBeUndefined();
    });
  });

  describe('gateMapping', () => {
    it('accepts gateMapping as record of string arrays', () => {
      const input = {
        gateMapping: {
          review: ['invariants', 'review'],
          build: ['compile', 'test'],
        },
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.gateMapping!.review).toEqual(['invariants', 'review']);
      expect(result.gateMapping!.build).toEqual(['compile', 'test']);
    });
  });

  describe('settings', () => {
    it('accepts settings as record of unknown values', () => {
      const input = {
        settings: {
          mutationTtlMs: 600000,
          retryMaxAttempts: 3,
          flag: true,
        },
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.settings!.mutationTtlMs).toBe(600000);
      expect(result.settings!.retryMaxAttempts).toBe(3);
      expect(result.settings!.flag).toBe(true);
    });
  });

  describe('phaseAssignments', () => {
    it('accepts phaseAssignments with id, priority, condition, result', () => {
      const input = {
        phaseAssignments: [
          {
            id: 'rule-1',
            priority: 10,
            condition: 'session.tasks.length > 0',
            result: 'EXECUTION',
          },
        ],
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.phaseAssignments).toHaveLength(1);
      expect(result.phaseAssignments![0].id).toBe('rule-1');
      expect(result.phaseAssignments![0].priority).toBe(10);
      expect(result.phaseAssignments![0].condition).toBe('session.tasks.length > 0');
      expect(result.phaseAssignments![0].result).toBe('EXECUTION');
    });
  });

  describe('editingAgents, verifiers, requiredGates', () => {
    it('accepts editingAgents, verifiers, requiredGates as string arrays', () => {
      const input = {
        editingAgents: ['code'],
        verifiers: ['architect'],
        requiredGates: ['invariants'],
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.editingAgents).toEqual(['code']);
      expect(result.verifiers).toEqual(['architect']);
      expect(result.requiredGates).toEqual(['invariants']);
    });
  });

  describe('extends', () => {
    it('accepts optional extends field', () => {
      const input = {
        extends: 'base/state-machine.yaml',
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.extends).toBe('base/state-machine.yaml');
    });

    it('accepts schema without extends', () => {
      const input = {
        phases: { PLANNING: {} },
      };

      const result = ProfileSchemaSchema.parse(input);

      expect(result.extends).toBeUndefined();
    });
  });
});
