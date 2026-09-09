import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Если env — абсолютный путь, возвращает как есть.
 * Иначе — наслаивает на base.
 */
export function absEnv(env: string | undefined, base: string): string | undefined {
  if (!env) return undefined;
  return env.startsWith('/') ? env : `${base}/${env}`;
}

/**
 * Базовая директория состояния OpenCode (глобально, не в проекте).
 * По умолчанию ~/.local/share/opencode.
 */
export function opencodeStateDir(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return `${dataHome}/opencode`;
}

/**
 * Корневая директория харнесса в проекте (по умолчанию .opencode).
 */
export function harnessDir(projectDir: string): string {
  return absEnv(process.env.OPENCODE_HARNESS_DIR, projectDir) ?? `${projectDir}/.opencode`;
}

/**
 * Директория профилей — конфигурация проекта.
 */
export function profilesDir(projectDir: string): string {
  return process.env.SESSION_GUARD_PROFILES_DIR ?? `${harnessDir(projectDir)}/profiles`;
}

/**
 * Директория рантайма.
 * baseDir — базовая директория (например, ~/.local/share/opencode или testRoot).
 * Переопределяется SESSION_GUARD_STORE_DIR.
 */
export function sessionsDir(baseDir: string): string {
  if (process.env.SESSION_GUARD_STORE_DIR) return process.env.SESSION_GUARD_STORE_DIR;
  return `${baseDir}/session-guard/runtime`;
}
