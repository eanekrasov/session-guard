/**
 * Live test: workflow-create without mocks
 * Run: bun test/live-workflow-create.test.ts
 */
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEST_DIR = resolve(tmpdir(), 'workflow-live-test-' + Date.now());
mkdirSync(TEST_DIR, { recursive: true });

console.log('📁 Test directory:', TEST_DIR);

// Setup env before importing runtime
process.env.SESSION_GUARD_STORE_DIR = TEST_DIR;
process.env.HARNESS_PROFILE = 'android';
if (!process.env.SESSION_GUARD_PROFILES_DIR) {
  process.env.SESSION_GUARD_PROFILES_DIR = resolve(import.meta.dir, '..', '..', 'profiles');
}

async function main() {
  console.log('\n🚀 Creating runtime...');
  const { createRuntime } = await import('../../src/app/runtime.ts');

  const runtime = createRuntime({
    client: {} as never,
    project: {
      id: 'live-test',
      name: 'live-test',
      directory: TEST_DIR,
      worktree: TEST_DIR,
      time: { created: Date.now() },
    } as never,
    directory: TEST_DIR,
    worktree: TEST_DIR,
    experimental_workspace: {} as never,
    serverUrl: new URL('http://localhost:0'),
    $: {} as never,
  });

  console.log('✅ Runtime created');
  console.log('📋 Available tools:', Object.keys(runtime.tool ?? {}));

  // Test 1: workflow-create with profileId
  console.log('\n🧪 Test 1: workflow-create with profileId');
  const result1 = await runtime.tool!['workflow-create'].execute(
    { schemaId: 'android' },
    {
      sessionID: 'live-session-1',
      messageID: 'msg-1',
      agent: 'live-test',
      directory: TEST_DIR,
      worktree: TEST_DIR,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
  );

  const output1 = typeof result1 === 'string' ? result1 : result1.output;
  const meta1 = typeof result1 === 'string' ? null : (result1.metadata ?? null);
  console.log('📤 Output:', output1);
  console.log('📊 Metadata:', JSON.stringify(meta1, null, 2));

  // Test 2: workflow-create without args (should fallback to HARNESS_PROFILE)
  console.log('\n🧪 Test 2: workflow-create without args (fallback to HARNESS_PROFILE)');
  const result2 = await runtime.tool!['workflow-create'].execute(
    {},
    {
      sessionID: 'live-session-2',
      messageID: 'msg-2',
      agent: 'live-test',
      directory: TEST_DIR,
      worktree: TEST_DIR,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
  );

  const output2 = typeof result2 === 'string' ? result2 : result2.output;
  console.log('📤 Output:', output2);

  // Cleanup
  console.log('\n🧹 Cleanup...');
  rmSync(TEST_DIR, { recursive: true, force: true });

  console.log('\n✅ Live test completed!');
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
