import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

import { createRuntime } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { parseConsentRequest, questionTextOf } from '../../src/app/consent.ts';
import type { SessionClient } from '../../src/app/runtime-types.ts';

/**
 * The consent tag the plugin emits must be the consent tag the plugin accepts.
 *
 * Both halves of this round trip were broken at once, and neither unit test nor
 * type checker noticed: the tag carried a revision its own manifest did not,
 * and the answer handler looked for the tag in the tool's output instead of the
 * question it was asked in. A host smoke run found it.
 */

let projectDir: string;
let storeDir: string;
let store: WorkflowStore;

function client(): SessionClient {
  return {
    messages: vi.fn().mockResolvedValue({
      data: [{ id: 'msg-1', parts: [{ type: 'text' }] }],
    }),
    prompt: vi.fn().mockResolvedValue({ data: {} }),
    list: vi.fn().mockResolvedValue({ data: [] }),
  } as unknown as SessionClient;
}

function pluginInput(): PluginInput {
  return {
    client: { session: client() } as unknown as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: projectDir,
      worktree: projectDir,
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: projectDir,
    worktree: projectDir,
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'consent-roundtrip-project-'));
  storeDir = mkdtempSync(join(tmpdir(), 'consent-roundtrip-store-'));
  process.env.STATE_MACHINE_STORE_DIR = storeDir;
  writeFileSync(join(projectDir, 'plan.md'), '# Plan\n\nDo the thing.\n', 'utf-8');
  store = new WorkflowStore(storeDir);
  const session = createSession('s1', 'base');
  await store.save(session);
  // A few saves, so the revision is well past zero and a stale read is visible.
  await store.save((await store.load('s1'))!);
  await store.save((await store.load('s1'))!);
});

describe('consent tag round trip', () => {
  it('emits a tag whose own parser accepts it', async () => {
    const hooks = createRuntime(pluginInput());
    const result = await hooks.tool!['workflow.consent'].execute(
      { files: ['plan.md'], summary: 'do the thing' },
      { sessionID: 's1' } as never
    );

    const parsed = parseConsentRequest(result.output);
    expect(parsed, `the emitted tag did not parse:\n${result.output}`).toBeDefined();
    expect(parsed!.manifest.revision).toBe(parsed!.revision);
  });

  it('reads the consent request from the question, not from the answer', async () => {
    const hooks = createRuntime(pluginInput());
    const prepared = await hooks.tool!['workflow.consent'].execute(
      { files: ['plan.md'], summary: 'do the thing' },
      { sessionID: 's1' } as never
    );
    const tag = /<consent-request[\s\S]*?<\/consent-request>/.exec(prepared.output)?.[0];
    expect(tag).toBeDefined();

    const args = {
      questions: [
        {
          question: tag,
          header: 'Consent',
          options: [{ label: 'grant' }, { label: 'decline' }],
        },
      ],
    };
    expect(parseConsentRequest(questionTextOf(args))).toBeDefined();

    // The host runs before → after around the question tool.
    await hooks['tool.execute.before']!(
      { tool: 'question', sessionID: 's1', callID: 'call-1' },
      { args }
    );
    await hooks['tool.execute.after']!(
      { tool: 'question', sessionID: 's1', callID: 'call-1', args },
      // The tool's output is the operator's answer — never the tag.
      { title: 'question', output: 'grant', metadata: { answers: ['grant'] } }
    );

    const session = await store.load('s1');
    expect(session?.refs.plan, 'the plan reference was never recorded').toBeTruthy();
    expect(
      session?.approvals.some((approval) => approval.type === 'plan' && approval.status === 'granted'),
      'consent was not granted'
    ).toBe(true);
  });
});
