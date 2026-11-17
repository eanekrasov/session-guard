import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeContext } from '../../src/app/runtime.ts';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import { parseConsentRequest, questionTextOf } from '../../src/app/consent.ts';
import { toolOutput } from '../support/tool-result.ts';

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

function runtimeContext(
  resolveParent: NonNullable<RuntimeContext['resolveParent']> = async () => null
): RuntimeContext {
  return {
    directory: projectDir,
    resolveParent,
    host: {
      directory: projectDir,
      session: { hasMessageContext: async () => true, prompt: async () => {} },
      tools: {},
      log: async () => {},
      report: () => {},
    },
  };
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: 'message-1',
    agent: 'test',
    directory: projectDir,
    worktree: projectDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'consent-roundtrip-project-'));
  storeDir = mkdtempSync(join(tmpdir(), 'consent-roundtrip-store-'));
  process.env.SESSION_GUARD_STORE_DIR = storeDir;
  writeFileSync(join(projectDir, 'plan.md'), '# Plan\n\nDo the thing.\n', 'utf-8');
  store = new WorkflowStore(storeDir);
  const session = createSession('s1', 'base', 'session-guard');
  await store.save(session);
  // A few saves, so the revision is well past zero and a stale read is visible.
  await store.save((await store.load('s1'))!);
  await store.save((await store.load('s1'))!);
});

describe('consent tag round trip', () => {
  it('normalizes a JSON-encoded file list before emitting the consent tag', async () => {
    const hooks = createRuntime(runtimeContext());
    const result = await hooks.tool!['workflow-consent']!.execute(
      { files: '["plan.md"]', summary: 'do the thing' },
      toolContext('s1')
    );
    expect(parseConsentRequest(toolOutput(result))?.manifest.files).toEqual(['plan.md']);
  });

  it('resolves a child session to its parent workflow', async () => {
    const hooks = createRuntime(
      runtimeContext(async (sessionID) => (sessionID === 'child' ? 's1' : null))
    );
    const result = await hooks.tool!['workflow-consent']!.execute(
      { files: ['plan.md'], summary: 'do the thing' },
      toolContext('child')
    );
    expect(parseConsentRequest(toolOutput(result))).toBeDefined();
  });

  it('emits a tag whose own parser accepts it', async () => {
    const hooks = createRuntime(runtimeContext());
    const result = await hooks.tool!['workflow-consent']!.execute(
      { files: ['plan.md'], summary: 'do the thing' },
      toolContext('s1')
    );

    const parsed = parseConsentRequest(toolOutput(result));
    expect(parsed, `the emitted tag did not parse:\n${toolOutput(result)}`).toBeDefined();
    expect(parsed!.manifest.revision).toBe(parsed!.revision);
  });

  it('reads the consent request from the question, not from the answer', async () => {
    const hooks = createRuntime(runtimeContext());
    const prepared = await hooks.tool!['workflow-consent']!.execute(
      { files: ['plan.md'], summary: 'do the thing' },
      toolContext('s1')
    );
    const tag = /<consent-request[\s\S]*?<\/consent-request>/.exec(toolOutput(prepared))?.[0];
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
      session?.approvals.some(
        (approval) => approval.type === 'plan' && approval.status === 'granted'
      ),
      'consent was not granted'
    ).toBe(true);
  });
});
