# Plugin Architecture

## Структура entry point

```
src/
  plugin.ts  — реализация плагина: StateMachinePlugin async (ctx) => Hooks
  index.ts   — публичное API библиотеки (типы, схемы, домен, createRuntime)
```

## Как загружается

OpenCode читает `package.json["main"]` (`./src/plugin.ts`) и вызывает
`default(ctx)` — получает объект Hooks (tool, chat.message, event, dispose).

Плагин — **server-only**. TUI-слой вынесен в отдельный модуль
(`tui-plugins/sidebar-state.tsx`).

## Сравнение с продакшен плагинами

| Компонент               | Наш плагин        | beads           | litellm                   | session-switch              |
|-------------------------|-------------------|-----------------|---------------------------|-----------------------------|
| `"main"` в package.json | `./src/plugin.ts` | `src/plugin.ts` | `./src/index.ts`          | `./index.ts`                |
| Entry point             | TS, `Plugin`      | TS, `Plugin`    | TS-bridge → `src/plugin/` | TS-bridge → `src/server.ts` |
| `plugins/`              | нет               | нет             | нет                       | нет                         |
| TUI                     | отдельный модуль  | нет             | нет                       | `dist/tui.js`               |
| JS-мост                 | нет               | нет             | нет                       | нет                         |

## Наш паттерн

- **Server plugin**: `src/plugin.ts` — async `(ctx: PluginInput) => Hooks`,
  named + default export (OpenCode читает default)
- **Library API**: `src/index.ts` — типы, схемы, домен, `createRuntime`
- **TUI plugin**: `tui-plugins/sidebar-state.tsx` — отдельный `TuiPluginModule`
- **Библиотечный экспорт**: `dist/index.js` через `"exports"."."` в package.json
  для npm-потребителей

Никаких vanilla JS мостов, никакой `plugins/` директории — чистый TypeScript
с entry point через package.json.

## История

Ранее entry point находился в `harness/plugins/state-machine.js` (vanilla JS мост).
При переходе на стандартный для OpenCode паттерн он был перенесён в
`plugins/plugin.ts`, а затем в `src/plugin.ts` — как у beads.

См. также: [usage.md](./usage.md) — подключение плагина, [roadmap.md](./roadmap.md) — сравнение со встроенной версией.
