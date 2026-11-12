import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOwner, useContext } from 'solid-js';
import { RendererContext } from '@opentui/solid';
import { usePlugin } from '@opencode/plugin/tui';

const DIAG_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode');
const DIAG_LOG = join(DIAG_DIR, 'session-guard-ui.log');
const DIAG_MAX_FAILURES_PER_SLOT = 3;
const DIAG_MAX_LOG_BYTES = 2_000_000;

export function diag(line: string): void {
  try {
    mkdirSync(DIAG_DIR, { recursive: true });
    if (existsSync(DIAG_LOG) && statSync(DIAG_LOG).size > DIAG_MAX_LOG_BYTES) {
      writeFileSync(DIAG_LOG, '', { mode: 0o600 });
    }
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${line}\\n`, { mode: 0o600 });
  } catch {
    // diagnostics must never crash the plugin
  }
}

try {
  diag(`module load: ${import.meta.url}`);
} catch (error) {
  diag(`module load probe failed: ${error}`);
}

export const diagOkSlots = new Set<string>();
export const diagFailureCount = new Map<string, number>();

export function diagFailure(slot: string, error: unknown): void {
  const count = (diagFailureCount.get(slot) ?? 0) + 1;
  diagFailureCount.set(slot, count);
  if (count > DIAG_MAX_FAILURES_PER_SLOT) {
    if (count === DIAG_MAX_FAILURES_PER_SLOT + 1) {
      diag(
        `render ${slot} still failing after ${DIAG_MAX_FAILURES_PER_SLOT} logged failures; further failures are suppressed until a render succeeds`
      );
    }
    return;
  }
  const lines = [
    `render ${slot} FAILED (${count}/${DIAG_MAX_FAILURES_PER_SLOT}): ${error instanceof Error ? error.message : String(error)}`,
    `  stack: ${error instanceof Error ? error.stack : '(none)'}`,
  ];
  try {
    const owner = getOwner() as { context?: Record<string, unknown> | null } | null;
    lines.push(
      `  owner=${owner ? 'present' : 'null'}; contextKeys=[${owner ? (owner.context ? Object.keys(owner.context).join(',') : 'null') : 'none'}]`
    );
  } catch (probeError) {
    lines.push(`  owner probe failed: ${probeError}`);
  }
  try {
    lines.push(
      `  useContext(RendererContext): ${useContext(RendererContext) ? 'found' : 'MISSING'}`
    );
  } catch (probeError) {
    lines.push(`  renderer probe failed: ${probeError}`);
  }
  try {
    usePlugin();
    lines.push('  usePlugin: ok');
  } catch (probeError) {
    lines.push(`  usePlugin: FAILED ${probeError}`);
  }
  diag(lines.join('\\n'));
}
