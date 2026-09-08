import { describe, expect, it } from 'bun:test';

import { compileWorkflow, initialStageOf } from '../../src/schema/compile-workflow.ts';
import { firstNestedStageId } from '../../src/schema/types.ts';
import type { ResolvedSchema } from '../../src/schema/types.ts';

/**
 * Порядок объявления — контракт, а не случайность.
 *
 * От того, какая стадия объявлена первой, зависят три независимых решения:
 *
 *   1. с какой стадии стартует workflow (`initialStageOf`);
 *   2. на какой вложенной стадии открывается прогон задачи
 *      (`firstNestedStageId` → `resolveMutationRun`);
 *   3. по какой стадии судится ПЕРВАЯ правка задачи — прогон к этому моменту
 *      ещё не открыт, и допуск обязан выбрать ту же стадию, что и жизненный
 *      цикл, иначе они расходятся (host-smoke 2026-09-08).
 *
 * Решено оставить порядок вместо явных `initial:` / `entry:`. Значит
 * перестановка двух блоков в YAML — правка форматирующего уровня — меняет
 * поведение в трёх местах. Эти тесты для того и стоят: чтобы такая
 * перестановка ломала сборку, а не тихо меняла workflow.
 */
describe('declaration order is the contract', () => {
  const loop = (...ids: string[]): ResolvedSchema => ({
    id: 'order',
    source: 'order.yaml',
    stages: {
      execution: {
        loop: 'implementation',
        stages: Object.fromEntries(ids.map((id) => [id, {}])),
      },
    },
    transitions: [],
  });

  it('starts the workflow at the first declared stage', () => {
    expect(initialStageOf({ planning: {}, done: {} })).toBe('planning');
    expect(initialStageOf({ done: {}, planning: {} })).toBe('done');
  });

  it('opens a task run on the first declared nested stage', () => {
    expect(firstNestedStageId(loop('code', 'verify').stages!.execution)).toBe('code');
    expect(firstNestedStageId(loop('verify', 'code').stages!.execution)).toBe('verify');
  });

  it('compiles the first declared stage as the workflow’s initial one', () => {
    const { workflow } = compileWorkflow({
      id: 'order',
      source: 'order.yaml',
      stages: { alpha: {}, beta: {} },
      transitions: [{ from: 'alpha', to: 'beta' }],
    });
    expect(workflow.initialStage).toBe('alpha');
  });

  it('the shipped base workflow depends on this: planning first, code first', async () => {
    const { resolveConfig } = await import('../../src/public-api.ts');
    const { join } = await import('node:path');
    const profile = await resolveConfig('base', join(import.meta.dir, '../../profiles'));
    const schema = profile.schemas.find((entry) => entry.id === 'base')!;

    expect(Object.keys(schema.stages!)[0]).toBe('planning');
    expect(firstNestedStageId(schema.stages!.execution)).toBe('code');
  });
});
