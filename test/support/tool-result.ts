import type { ToolResult } from '@opencode-ai/plugin';

/**
 * Сузить `ToolResult` до объектной формы.
 *
 * `ToolResult` — это `string | { output: string; … }`, поэтому читать `.output`
 * прямо с результата нельзя. Наши workflow-инструменты всегда возвращают
 * объект; строковая ветка здесь означала бы, что инструмент изменил контракт,
 * и это стоит увидеть как падение теста, а не как приведение типа.
 */
export function toolOutput(result: ToolResult): string {
  if (typeof result === 'string') {
    throw new Error(`Expected a tool result object, got a bare string: ${result}`);
  }
  return result.output;
}
