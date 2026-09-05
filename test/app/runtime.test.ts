import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { PluginInput } from '@opencode-ai/plugin';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let prevStoreDir: string | undefined;
let prevProfilesDir: string | undefined;
const cleanupDirs: string[] = [];

beforeEach(() => {
  prevStoreDir = process.env.STATE_MACHINE_STORE_DIR;
  prevProfilesDir = process.env.STATE_MACHINE_PROFILES_DIR;
  process.env.STATE_MACHINE_STORE_DIR =
    '/tmp/state-machine-test-' + Math.random().toString(36).slice(2);
  delete process.env.STATE_MACHINE_PROFILES_DIR;
});

afterEach(() => {
  if (prevStoreDir !== undefined) {
    process.env.STATE_MACHINE_STORE_DIR = prevStoreDir;
  } else {
    delete process.env.STATE_MACHINE_STORE_DIR;
  }
  if (prevProfilesDir !== undefined) {
    process.env.STATE_MACHINE_PROFILES_DIR = prevProfilesDir;
  } else {
    delete process.env.STATE_MACHINE_PROFILES_DIR;
  }
  for (const directory of cleanupDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createPluginInput(): PluginInput {
  return {
    client: {
      app: {
        log: async () => {},
      },
    } as unknown as PluginInput['client'],
    project: {
      id: 'test',
      name: 'test',
      directory: '/tmp/test',
      worktree: '/tmp/test',
      time: { created: Date.now() },
    } as PluginInput['project'],
    directory: '/tmp/test',
    worktree: '/tmp/test',
    experimental_workspace: {} as PluginInput['experimental_workspace'],
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  };
}

async function createRuntime() {
  const mod = await import('../../src/app/runtime.ts');
  return mod.createRuntime(createPluginInput());
}

async function createTestSession(
  sessionId: string,
  profileId: string = 'test-profile',
  overrides?: Partial<import('../../src/session/session-schema.ts').WorkflowSession>
): Promise<import('../../src/session/session-schema.ts').WorkflowSession> {
  const store = new WorkflowStore(process.env.STATE_MACHINE_STORE_DIR!);
  const session = createSession(sessionId, profileId);
  if (overrides) {
    Object.assign(session, overrides);
  }
  await store.save(session);
  return session;
}

async function loadSession(
  sessionId: string
): Promise<import('../../src/session/session-schema.ts').WorkflowSession | null> {
  const store = new WorkflowStore(process.env.STATE_MACHINE_STORE_DIR!);
  return store.load(sessionId);
}

function taskCycle(): Pick<
  import('../../src/session/session-schema.ts').WorkflowSession,
  'tasks' | 'loopRuns'
> {
  return {
    tasks: {
      implementation: [{ id: 'task-1', path: 'src/task-1.ts', status: 'pending' }],
    },
    loopRuns: {},
  };
}

function activeOperation(
  callId: string,
  agent = 'test'
): Pick<
  import('../../src/session/session-schema.ts').WorkflowSession,
  'tasks' | 'loopRuns' | 'activeOperations'
> {
  return {
    tasks: {
      implementation: [{ id: 'task-1', path: 'src/task-1.ts', status: 'running' }],
    },
    loopRuns: {
      'run-1': {
        id: 'run-1',
        taskId: 'task-1',
        listKey: 'implementation',
        ancestry: [],
        stage: 'dev',
        status: 'running',
      },
    },
    activeOperations: {
      [callId]: {
        callId,
        runId: 'run-1',
        taskId: 'task-1',
        agent,
        startedAt: new Date().toISOString(),
        status: 'running',
      },
    },
  };
}

function setExecutableProfilesDir(): void {
  const profilesDir = mkdtempSync(join(tmpdir(), 'runtime-profiles-'));
  cleanupDirs.push(profilesDir);
  const profileDir = join(profilesDir, 'test-profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'profile.json'),
    JSON.stringify({ id: 'test-profile', name: 'test-profile', schemas: ['state-machine.yaml'] }),
    'utf-8'
  );
  writeFileSync(
    join(profileDir, 'state-machine.yaml'),
    [
      'phases:',
      '  EXECUTION:',
      '    loop: implementation',
      '    dispatch:',
      '      strategy: serial',
      '    stages:',
      '      - id: dev',
      "        allowedAgents: ['code', 'my-agent', 'fallback-agent']",
      'phaseAssignments:',
      '  - id: execution',
      '    priority: 1',
      "    condition: 'true'",
      '    result: EXECUTION',
    ].join('\n'),
    'utf-8'
  );
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDir;
}

// ─── handleWorkflowResult ────────────────────────────────────────────────────

describe('handleWorkflowResult (via handleToolAfter)', () => {
  test('adds verification to session when output contains <workflow-result>', async () => {
    const hooks = await createRuntime();
    const sessionId = 'wf-result-1';
    await createTestSession(sessionId);

    const output = {
      title: 'test',
      output: [
        'Some text before',
        '<workflow-result>{"stage":"review","status":"pass","summary":"All checks passed","evidence":["check-1","check-2"]}</workflow-result>',
        'Some text after',
      ].join('\n'),
      metadata: {},
    };

    await hooks['tool.execute.after']!(
      { tool: 'Read', sessionID: sessionId, callID: 'call-wf-1', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.verifications.length).toBe(1);
    expect(session!.verifications[0].stage).toBe('review');
    expect(session!.verifications[0].status).toBe('confirmed');
  });

  test('does nothing when output has no <workflow-result> tag', async () => {
    const hooks = await createRuntime();
    const sessionId = 'wf-result-2';
    await createTestSession(sessionId);

    const output = {
      title: 'test',
      output: 'Just a normal output without workflow result tag',
      metadata: {},
    };

    await hooks['tool.execute.after']!(
      { tool: 'Read', sessionID: sessionId, callID: 'call-wf-2', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.verifications.length).toBe(0);
  });

  test('clears activeOperation when id matches callID', async () => {
    setExecutableProfilesDir();
    const hooks = await createRuntime();
    const sessionId = 'wf-result-clear';
    await createTestSession(sessionId, 'test-profile', {
      ...activeOperation('call-wf-clear'),
    });

    const output = {
      title: 'test',
      output:
        '<workflow-result>{"stage":"qa","status":"pass","summary":"QA passed","evidence":["e1"]}</workflow-result>',
      metadata: {},
    };

    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: sessionId, callID: 'call-wf-clear', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['call-wf-clear']).toBeUndefined();
  });

  test('does not clear a different active operation when callID does not match', async () => {
    const hooks = await createRuntime();
    const sessionId = 'wf-result-no-clear';
    await createTestSession(sessionId, 'test-profile', {
      ...activeOperation('other-call'),
    });

    const output = {
      title: 'test',
      output:
        '<workflow-result>{"stage":"review","status":"fail","summary":"Failed","evidence":["e1"]}</workflow-result>',
      metadata: {},
    };

    await hooks['tool.execute.after']!(
      { tool: 'task', sessionID: sessionId, callID: 'different-call', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['other-call']).toMatchObject({ callId: 'other-call' });
  });
});

// ─── handleFileToolAfter ─────────────────────────────────────────────────────

describe('handleFileToolAfter (via handleToolAfter)', () => {
  test('does not throw for edit tool with valid .ts file', async () => {
    const hooks = await createRuntime();
    const sessionId = 'file-tool-ok';
    await createTestSession(sessionId);

    // handleFileToolAfter will try to validateFilesForProfile which will fail
    // because there's no profile — but it should be caught and not throw
    await expect(
      hooks['tool.execute.after']!(
        {
          tool: 'edit',
          sessionID: sessionId,
          callID: 'call-edit-1',
          args: { filePath: 'src/test.ts' },
        },
        { title: 'edit', output: 'file edited', metadata: {} }
      )
    ).resolves.toBeUndefined();
  });

  test('does not add validation output for unsupported file extension', async () => {
    const hooks = await createRuntime();
    const sessionId = 'file-tool-ext';
    await createTestSession(sessionId);

    const output = { title: 'edit', output: 'file edited', metadata: {} };

    // .png is not supported → handleFileToolAfter returns early
    await hooks['tool.execute.after']!(
      {
        tool: 'edit',
        sessionID: sessionId,
        callID: 'call-ext-1',
        args: { filePath: 'image.png' },
      },
      output
    );

    // output should remain unchanged (no validation added)
    expect(output.output).toBe('file edited');
  });

  test('is no-op for non-file tools (Bash)', async () => {
    const hooks = await createRuntime();
    const sessionId = 'file-tool-noop';
    await createTestSession(sessionId);

    const output = { title: 'bash', output: 'ok', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'Bash',
        sessionID: sessionId,
        callID: 'call-bash-1',
        args: { command: 'echo hi' },
      },
      output
    );

    expect(output.output).toBe('ok');
  });

  test('is no-op for file tool when args have no filePath/path/file field', async () => {
    const hooks = await createRuntime();
    const sessionId = 'file-tool-no-args';
    await createTestSession(sessionId);

    const output = { title: 'edit', output: 'ok', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'edit',
        sessionID: sessionId,
        callID: 'call-no-fields',
        args: { content: 'some content' },
      },
      output
    );

    expect(output.output).toBe('ok');
  });

  test('is no-op when file does not exist on disk', async () => {
    const hooks = await createRuntime();
    const sessionId = 'file-tool-missing';
    await createTestSession(sessionId);

    const output = { title: 'edit', output: 'ok', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'edit',
        sessionID: sessionId,
        callID: 'call-missing',
        args: { filePath: 'src/nonexistent.ts' },
      },
      output
    );

    expect(output.output).toBe('ok');
  });
});

// ─── Mutation finalization (via handleToolAfter → mutationAfter) ──────────

describe('mutation finalization (via handleToolAfter)', () => {
  test('does nothing when session has no active operation', async () => {
    const hooks = await createRuntime();
    const sessionId = 'mut-no-op';
    await createTestSession(sessionId);

    const output = { title: 'bash', output: 'done', metadata: {} };

    await hooks['tool.execute.after']!(
      { tool: 'Bash', sessionID: sessionId, callID: 'call-no-op', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations).toEqual({});
  });

  test('for Bash with different callID, mutationAfter leaves another active operation alone', async () => {
    const hooks = await createRuntime();
    const sessionId = 'mut-wrong-call';
    await createTestSession(sessionId, 'test-profile', {
      ...activeOperation('other-call'),
    });

    const output = { title: 'bash', output: 'done', metadata: {} };

    await hooks['tool.execute.after']!(
      { tool: 'Bash', sessionID: sessionId, callID: 'wrong-call', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['other-call']).toMatchObject({ callId: 'other-call' });
  });

  test('is no-op for non-Bash/Write tools even with activeOperation', async () => {
    const hooks = await createRuntime();
    const sessionId = 'mut-read-only';
    await createTestSession(sessionId, 'test-profile', {
      ...activeOperation('call-read'),
    });

    const output = { title: 'read', output: 'content', metadata: {} };

    await hooks['tool.execute.after']!(
      { tool: 'Read', sessionID: sessionId, callID: 'call-read', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['call-read']).toMatchObject({ callId: 'call-read' });
  });
});

// ─── handleTaskBefore (via handleToolBefore) ─────────────────────────────────

describe('handleTaskBefore (via handleToolBefore)', () => {
  test('sets activeOperation when tool=task and session exists', async () => {
    setExecutableProfilesDir();
    const hooks = await createRuntime();
    const sessionId = 'task-before-ok';
    await createTestSession(sessionId, 'test-profile', taskCycle());

    const output = { args: {} };
    await hooks['tool.execute.before']!(
      {
        tool: 'task',
        sessionID: sessionId,
        callID: 'call-task-1',
        args: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
      },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['call-task-1']).toMatchObject({
      callId: 'call-task-1',
      agent: 'code',
      status: 'running',
    });
  });

  test('is a no-op when session does not exist', async () => {
    const hooks = await createRuntime();
    const output = { args: {} };
    await hooks['tool.execute.before']!(
      {
        tool: 'task',
        sessionID: 'nonexistent',
        callID: 'call-task-2',
        args: { subagent_type: 'code' },
      },
      output
    );
    // If no session, handleTaskBefore returns early — no throw
  });

  test('is a no-op when isMutationTask returns false (non-task tool)', async () => {
    const hooks = await createRuntime();
    const sessionId = 'task-before-noop';
    await createTestSession(sessionId);

    const output = { args: {} };
    // Read is not a 'task' tool, so isMutationTask returns false
    await hooks['tool.execute.before']!(
      { tool: 'Read', sessionID: sessionId, callID: 'call-read', args: {} },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations).toEqual({});
  });

  test('is a no-op when args have no agent/subagent_type/type field', async () => {
    const hooks = await createRuntime();
    const sessionId = 'task-before-no-agent';
    await createTestSession(sessionId);

    const output = { args: {} };
    await hooks['tool.execute.before']!(
      { tool: 'task', sessionID: sessionId, callID: 'call-no-agent', args: { unrelated: 'value' } },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations).toEqual({});
  });

  test('skips when activeOperation already exists with a different callID', async () => {
    setExecutableProfilesDir();
    const hooks = await createRuntime();
    const sessionId = 'task-before-locked';
    await createTestSession(sessionId, 'test-profile', {
      ...activeOperation('existing-call', 'existing'),
    });

    const output = { args: {} };
    await hooks['tool.execute.before']!(
      {
        tool: 'task',
        sessionID: sessionId,
        callID: 'new-call',
        args: { subagent_type: 'code', description: '[workflow-task:task-1] implement' },
      },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['existing-call']).toMatchObject({ callId: 'existing-call' });
    expect(session!.activeOperations['new-call']).toBeUndefined();
  });

  test('uses .agent field when subagent_type is absent', async () => {
    setExecutableProfilesDir();
    const hooks = await createRuntime();
    const sessionId = 'task-before-agent';
    await createTestSession(sessionId, 'test-profile', taskCycle());

    const output = { args: {} };
    await hooks['tool.execute.before']!(
      {
        tool: 'task',
        sessionID: sessionId,
        callID: 'call-agent',
        args: { agent: 'my-agent', description: '[workflow-task:task-1] implement' },
      },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['call-agent'].agent).toBe('my-agent');
  });

  test('uses .type field when both subagent_type and agent are absent', async () => {
    setExecutableProfilesDir();
    const hooks = await createRuntime();
    const sessionId = 'task-before-type';
    await createTestSession(sessionId, 'test-profile', taskCycle());

    const output = { args: {} };
    await hooks['tool.execute.before']!(
      {
        tool: 'task',
        sessionID: sessionId,
        callID: 'call-type',
        args: { type: 'fallback-agent', description: '[workflow-task:task-1] implement' },
      },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.activeOperations['call-type'].agent).toBe('fallback-agent');
  });
});

// ─── Generic tool blocking (replaces commit-specific tests) ─────────────────

const REAL_PROFILES_DIR = join(import.meta.dirname, '../../profiles');

describe('generic tool blocking', () => {
  test('forbidden git command is blocked', async () => {
    const prevProfiles = process.env.STATE_MACHINE_PROFILES_DIR;
    process.env.STATE_MACHINE_PROFILES_DIR = REAL_PROFILES_DIR;

    const hooks = await createRuntime();
    const sessionId = 'forbidden-git';
    await createTestSession(sessionId, 'base');

    const output = { args: {} };
    await hooks['tool.execute.before']!(
      {
        tool: 'Bash',
        sessionID: sessionId,
        callID: 'call-1',
        args: { command: 'git commit -m "test"' },
      },
      output
    );

    expect(output.args).toBeDefined();
    const blockedOutput = output.args as { blocked?: boolean; reason?: string };
    expect(blockedOutput.blocked).toBe(true);

    process.env.STATE_MACHINE_PROFILES_DIR = prevProfiles;
  });
});

// ─── handleFileToolAfter with real file on disk ───────────────────────────

describe('handleFileToolAfter with real file on disk', () => {
  test('runs validation on an existing .ts file and does not throw', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'file-val-'));
    const sessionId = 'file-val-ts';
    const testFilePath = join(tmpDir, 'src', 'test.ts');
    const testFileDir = join(tmpDir, 'src');
    execSync(`mkdir -p ${testFileDir}`, { encoding: 'utf-8' });
    writeFileSync(testFilePath, 'const x = 1;\n', 'utf-8');

    const mod = await import('../../src/app/runtime.ts');
    const input: PluginInput = {
      client: { app: { log: async () => {} } } as unknown as PluginInput['client'],
      project: {
        id: 'test',
        name: 'test',
        directory: tmpDir,
        worktree: tmpDir,
        time: { created: Date.now() },
      } as PluginInput['project'],
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: {} as PluginInput['experimental_workspace'],
      serverUrl: new URL('http://localhost:0'),
      $: {} as PluginInput['$'],
    };
    const hooks = mod.createRuntime(input);
    await createTestSession(sessionId, 'base');

    const stateDir = process.env.STATE_MACHINE_PROFILES_DIR;
    process.env.STATE_MACHINE_PROFILES_DIR = REAL_PROFILES_DIR;

    const output = { title: 'edit', output: 'file edited', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'edit',
        sessionID: sessionId,
        callID: 'call-file-val',
        args: { filePath: 'src/test.ts' },
      },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();

    process.env.STATE_MACHINE_PROFILES_DIR = stateDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('is no-op when file is outside project directory', async () => {
    const hooks = await createRuntime();
    const sessionId = 'file-outside';
    await createTestSession(sessionId);

    const output = { title: 'edit', output: 'ok', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'edit',
        sessionID: sessionId,
        callID: 'call-outside',
        args: { filePath: '/etc/passwd' },
      },
      output
    );

    expect(output.output).toBe('ok');
  });

  test('handleFileToolAfter catches and logs when validateFiles fails', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'file-val-catch-'));
    const sessionId = 'file-val-catch';
    const testFileDir = join(tmpDir, 'src');
    execSync(`mkdir -p ${testFileDir}`, { encoding: 'utf-8' });
    writeFileSync(join(testFileDir, 'test.ts'), 'const x = 1;\n', 'utf-8');

    const mod = await import('../../src/app/runtime.ts');
    const input: PluginInput = {
      client: { app: { log: async () => {} } } as unknown as PluginInput['client'],
      project: {
        id: 'test',
        name: 'test',
        directory: tmpDir,
        worktree: tmpDir,
        time: { created: Date.now() },
      } as PluginInput['project'],
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: {} as PluginInput['experimental_workspace'],
      serverUrl: new URL('http://localhost:0'),
      $: {} as PluginInput['$'],
    };

    // Don't set STATE_MACHINE_PROFILES_DIR — profiles dir defaults to <directory>/profiles
    // which doesn't exist. Still should not throw.
    const hooks = mod.createRuntime(input);
    await createTestSession(sessionId, 'nonexistent-profile');

    const output = { title: 'edit', output: 'ok', metadata: {} };
    await expect(
      hooks['tool.execute.after']!(
        {
          tool: 'edit',
          sessionID: sessionId,
          callID: 'call-val-catch',
          args: { filePath: 'src/test.ts' },
        },
        output
      )
    ).resolves.toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── handleFileToolAfter — строка 577, правая ветка ?? ─────────────────────

describe('handleFileToolAfter default profiles dir (no STATE_MACHINE_PROFILES_DIR)', () => {
  test('uses default profiles dir when STATE_MACHINE_PROFILES_DIR is not set', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'file-def-'));
    delete process.env.STATE_MACHINE_PROFILES_DIR;

    const testFileDir = join(tmpDir, 'src');
    execSync(`mkdir -p ${testFileDir}`, { encoding: 'utf-8' });
    writeFileSync(join(testFileDir, 'test.ts'), 'const x = 1;\n', 'utf-8');

    const mod = await import('../../src/app/runtime.ts');
    const input: PluginInput = {
      client: { app: { log: async () => {} } } as unknown as PluginInput['client'],
      project: {
        id: 'test',
        name: 'test',
        directory: tmpDir,
        worktree: tmpDir,
        time: { created: Date.now() },
      } as PluginInput['project'],
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: {} as PluginInput['experimental_workspace'],
      serverUrl: new URL('http://localhost:0'),
      $: {} as PluginInput['$'],
    };

    const hooks = mod.createRuntime(input);
    const sessionId = 'file-def-profile';
    await createTestSession(sessionId, 'base');

    const output = { title: 'edit', output: 'file edited', metadata: {} };
    await hooks['tool.execute.after']!(
      {
        tool: 'edit',
        sessionID: sessionId,
        callID: 'call-file-def',
        args: { filePath: 'src/test.ts' },
      },
      output
    );

    const session = await loadSession(sessionId);
    expect(session).not.toBeNull();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── handleDispose, handleConfig, listSessions ─────────────────────────────

describe('handleDispose, handleConfig, listSessions', () => {
  test('handleDispose clears resources via dispose hook', async () => {
    const hooks = await createRuntime();
    await hooks.dispose!();
    // dispose should not throw
  });

  test('handleConfig registers sm-* commands and state-machine agent', async () => {
    const hooks = await createRuntime();
    const config: Record<string, unknown> = {
      model: 'test-model',
    };
    await hooks.config!(config as never);
    expect(config.command).toBeDefined();
    expect((config.command as Record<string, unknown>)['sm-status']).toBeDefined();
    expect((config.command as Record<string, unknown>)['sm-list']).toBeDefined();
    expect((config.command as Record<string, unknown>)['sm-session']).toBeDefined();
    expect((config.command as Record<string, unknown>)['sm-profile']).toBeDefined();
    expect(config.agent).toBeDefined();
    expect((config.agent as Record<string, unknown>)['state-machine']).toBeDefined();
  });
});
