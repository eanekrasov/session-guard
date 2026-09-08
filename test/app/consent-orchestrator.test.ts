import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSession, WorkflowStore } from '../../src/session/session-store.ts';
import type { ConsentManifest } from '../../src/app/consent.ts';
import type { SessionClient } from '../../src/app/runtime-types.ts';
import { hostPayload } from '../support/host-payload.ts';

// ─── Helpers ──────────────────────────────────────────────────────

let storeDir: string;
let store: WorkflowStore;
const directory = '/tmp/test';

beforeEach(() => {
  storeDir = '/tmp/state-machine-test-' + Math.random().toString(36).slice(2);
  store = new WorkflowStore(storeDir);
});

function mockClient(
  messagesResult?: Array<{ id: string; parts: Array<{ type: string; status?: string }> }>
): SessionClient {
  return hostPayload({
    messages: vi.fn().mockResolvedValue({
      data: messagesResult ?? [{ id: 'msg-1', parts: [{ type: 'text', status: 'completed' }] }],
    }),
    prompt: vi.fn().mockResolvedValue({ data: {} }),
    list: vi.fn().mockResolvedValue({ data: [] }),
  });
}

async function makeOrchestrator(client?: SessionClient) {
  const { ConsentOrchestrator } = await import('../../src/app/consent-orchestrator.ts');
  const { SessionQueue } = await import('../../src/app/session-queue.ts');
  const queue = new SessionQueue(store);
  return new ConsentOrchestrator(store, queue, directory, '', client ?? mockClient());
}

function findOpenApproval(session: Awaited<ReturnType<WorkflowStore['load']>>) {
  return session?.approvals.find(
    (approval) => approval.type === 'plan' && approval.status === 'pending'
  );
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('ConsentOrchestrator.before', () => {
  it('ignores question text without a consent-request tag', async () => {
    await store.save(createSession('co-no-tag', 'base', 'state-machine'));
    const orchestrator = await makeOrchestrator();

    await orchestrator.before('co-no-tag', 'call-no-tag', 'Are you sure?');

    const session = await store.load('co-no-tag');
    expect(findOpenApproval(session)).toBeUndefined();
  });

  it('ignores a consent request when the plan file does not exist', async () => {
    await store.save(createSession('co-no-plan', 'base', 'state-machine'));
    const orchestrator = await makeOrchestrator();
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Test feature',
      files: ['.opencode/plan/missing-story/plan.md'],
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);
    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    await orchestrator.before('co-no-plan', 'call-no-plan', questionText);

    const session = await store.load('co-no-plan');
    expect(findOpenApproval(session)).toBeUndefined();
  });

  it('sets a pending approval when the consent request is valid and the plan exists', async () => {
    await store.save(createSession('co-valid', 'base', 'state-machine'));
    const orchestrator = await makeOrchestrator();
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Implement feature X',
      files: ['.opencode/plan/feature-x/plan.md'],
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);

    const planDir = join(directory, '.opencode/plan/feature-x');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), '# Plan v1\n');

    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    await orchestrator.before('co-valid', 'call-valid', questionText);

    const session = await store.load('co-valid');
    const pendingApproval = findOpenApproval(session);
    expect(pendingApproval?.callId).toBe('call-valid');
    expect(pendingApproval?.evidence).toEqual(expect.stringContaining('sha256:'));
    expect(session?.refs.plan).toContain('feature-x');
  });

  it('dedups when the callID has already consented', async () => {
    const session = createSession('co-dedup', 'base', 'state-machine');
    session.consentedCallIDs = ['call-dup'];
    await store.save(session);
    const orchestrator = await makeOrchestrator();
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Dup feature',
      files: ['.opencode/plan/dup-feature/plan.md'],
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);
    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    await orchestrator.before('co-dedup', 'call-dup', questionText);

    const reloaded = await store.load('co-dedup');
    expect(findOpenApproval(reloaded)).toBeUndefined();
  });
});

describe('ConsentOrchestrator.after', () => {
  it('approves the plan on a grant answer', async () => {
    const storyId = 'feature-grant';
    const planContent = '# Plan for grant\n';
    const planDir = join(directory, '.opencode/plan', storyId);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), planContent);

    const orchestrator = await makeOrchestrator();
    const { evidenceOf, calculatePlanEvidence, CONSENT_EVIDENCE_SCHEMA } =
      await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Feature grant',
      files: [`.opencode/plan/${storyId}/plan.md`],
    } as const;
    const manifestEvidence = evidenceOf(manifest as unknown as ConsentManifest);
    const planEvidence = calculatePlanEvidence(planContent);
    void planEvidence;

    await store.save(createSession('co-grant', 'base', 'state-machine'));

    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${manifestEvidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    // Populate the pending approval first.
    await orchestrator.before('co-grant', 'call-grant', questionText);

    await orchestrator.after(
      'co-grant',
      'call-grant',
      {},
      { title: 'Consent', output: questionText, metadata: { answers: ['grant'] } }
    );

    const session = await store.load('co-grant');
    expect(session).not.toBeNull();
    const planApproval = session!.approvals.find((a) => a.type === 'plan');
    expect(planApproval).toBeDefined();
    expect(planApproval!.status).toBe('granted');
    expect(findOpenApproval(session)).toBeUndefined();
  });

  it('is a no-op when there is no pending approval', async () => {
    await store.save(createSession('co-no-pending', 'base', 'state-machine'));
    const orchestrator = await makeOrchestrator();

    await expect(
      orchestrator.after(
        'co-no-pending',
        'call-none',
        {},
        { title: 't', output: 'no tag here', metadata: {} }
      )
    ).resolves.toBeUndefined();

    const session = await store.load('co-no-pending');
    expect(findOpenApproval(session)).toBeUndefined();
  });

  it('calls client.session.messages() in before() to verify session context', async () => {
    await store.save(createSession('co-messages', 'base', 'state-machine'));
    const client = mockClient();
    const orchestrator = await makeOrchestrator(client);
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Messages test',
      files: ['.opencode/plan/no-plan/plan.md'],
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);
    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    await orchestrator.before('co-messages', 'call-messages', questionText);

    expect(client.messages).toHaveBeenCalledWith({
      path: { id: 'co-messages' },
      query: { limit: 5 },
    });
  });

  it('injects a synthetic prompt on grant via client.session.prompt()', async () => {
    const storyId = 'feature-synthetic';
    const planContent = '# Plan for synthetic\n';
    const planDir = join(directory, '.opencode/plan', storyId);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), planContent);

    const client = mockClient();
    const orchestrator = await makeOrchestrator(client);
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Synthetic test',
      files: [`.opencode/plan/${storyId}/plan.md`],
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);
    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    await store.save(createSession('co-synthetic', 'base', 'state-machine'));
    await orchestrator.before('co-synthetic', 'call-synthetic', questionText);
    await orchestrator.after(
      'co-synthetic',
      'call-synthetic',
      {},
      { title: 'Consent', output: questionText, metadata: { answers: ['grant'] } }
    );

    // Verify prompt was called with the synthetic message
    expect(client.prompt).toHaveBeenCalledTimes(1);
    const promptCall = (client.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(promptCall.path.id).toBe('co-synthetic');
    expect(promptCall.body.noReply).toBe(true);
    expect(promptCall.body.parts[0].type).toBe('text');
    expect(promptCall.body.parts[0].text).toContain("Consent 'plan' approved");
  });

  it('is a no-op when the callID does not match the pending approval', async () => {
    const storyId = 'feature-mismatch';
    const planContent = '# Plan\n';
    const planDir = join(directory, '.opencode/plan', storyId);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), planContent);

    const orchestrator = await makeOrchestrator();
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Mismatch feature',
      files: [`.opencode/plan/${storyId}/plan.md`],
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);
    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

    await store.save(createSession('co-mismatch', 'base', 'state-machine'));
    await orchestrator.before('co-mismatch', 'call-original', questionText);

    await orchestrator.after(
      'co-mismatch',
      'call-different',
      {},
      { title: 't', output: questionText, metadata: { answers: ['grant'] } }
    );

    const session = await store.load('co-mismatch');
    expect(findOpenApproval(session)?.callId).toBe('call-original');
  });

  // ─── P1-015 tests ──────────────────────────────────────────────────────────

  describe('verifyPlanEvidenceAtDecision', () => {
    it('grants when plan file has not changed between before() and after()', async () => {
      const storyId = 'feature-stable';
      const planContent = '# Plan for verify stable\n';
      const planDir = join(directory, '.opencode/plan', storyId);
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'plan.md'), planContent);

      const orchestrator = await makeOrchestrator();
      const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

      const manifest = {
        schema: CONSENT_EVIDENCE_SCHEMA,
        revision: 1,
        summary: 'Verify stable',
        files: [`.opencode/plan/${storyId}/plan.md`],
      } as const;
      const evidence = evidenceOf(manifest as unknown as ConsentManifest);
      const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

      await store.save(createSession('co-stable', 'base', 'state-machine'));
      await orchestrator.before('co-stable', 'call-stable', questionText);
      await orchestrator.after(
        'co-stable',
        'call-stable',
        {},
        { title: 'Consent', output: questionText, metadata: { answers: ['grant'] } }
      );

      const session = await store.load('co-stable');
      const planApproval = session!.approvals.find((a) => a.type === 'plan');
      expect(planApproval).toBeDefined();
      expect(planApproval!.status).toBe('granted');
    });

    it('denies grant when plan file changed between before() and after()', async () => {
      const storyId = 'feature-changed';
      const planContentBefore = '# Plan original\n';
      const planDir = join(directory, '.opencode/plan', storyId);
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'plan.md'), planContentBefore);

      const orchestrator = await makeOrchestrator();
      const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

      const manifest = {
        schema: CONSENT_EVIDENCE_SCHEMA,
        revision: 1,
        summary: 'Changed plan',
        files: [`.opencode/plan/${storyId}/plan.md`],
      } as const;
      const evidence = evidenceOf(manifest as unknown as ConsentManifest);
      const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

      await store.save(createSession('co-changed', 'base', 'state-machine'));
      await orchestrator.before('co-changed', 'call-changed', questionText);

      // Change the plan file between before() and after() — simulate race condition
      writeFileSync(join(planDir, 'plan.md'), '# Plan modified after question\n');

      await orchestrator.after(
        'co-changed',
        'call-changed',
        {},
        { title: 'Consent', output: questionText, metadata: { answers: ['grant'] } }
      );

      // Plan should NOT be approved because evidence changed
      const session = await store.load('co-changed');
      const planApproval = session!.approvals.find((a) => a.type === 'plan');
      expect(planApproval).toBeUndefined();
      expect(findOpenApproval(session)).toBeUndefined();
    });
  });

  describe('HARNESS_AUTO_APPROVE', () => {
    it('auto-approves the plan when env var is true', async () => {
      process.env.HARNESS_AUTO_APPROVE = 'true';

      const storyId = 'feature-auto';
      const planContent = '# Plan auto\n';
      const planDir = join(directory, '.opencode/plan', storyId);
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'plan.md'), planContent);

      const orchestrator = await makeOrchestrator();
      const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

      const manifest = {
        schema: CONSENT_EVIDENCE_SCHEMA,
        revision: 1,
        summary: 'Auto approve',
        files: [`.opencode/plan/${storyId}/plan.md`],
      } as const;
      const evidence = evidenceOf(manifest as unknown as ConsentManifest);
      const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

      await store.save(createSession('co-auto', 'base', 'state-machine'));
      await orchestrator.before('co-auto', 'call-auto', questionText);

      // After before(), plan should already be approved (auto-approve)
      const session = await store.load('co-auto');
      const planApproval = session!.approvals.find((a) => a.type === 'plan');
      expect(planApproval).toBeDefined();
      expect(planApproval!.status).toBe('granted');
      expect(findOpenApproval(session)).toBeUndefined();

      delete process.env.HARNESS_AUTO_APPROVE;
    });

    it('does NOT auto-approve when env var is not set', async () => {
      delete process.env.HARNESS_AUTO_APPROVE;

      const storyId = 'feature-no-auto';
      const planContent = '# Plan no auto\n';
      const planDir = join(directory, '.opencode/plan', storyId);
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'plan.md'), planContent);

      const orchestrator = await makeOrchestrator();
      const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');

      const manifest = {
        schema: CONSENT_EVIDENCE_SCHEMA,
        revision: 1,
        summary: 'No auto',
        files: [`.opencode/plan/${storyId}/plan.md`],
      } as const;
      const evidence = evidenceOf(manifest as unknown as ConsentManifest);
      const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;

      await store.save(createSession('co-no-auto', 'base', 'state-machine'));
      await orchestrator.before('co-no-auto', 'call-no-auto', questionText);

      // Plan should NOT be auto-approved
      const session = await store.load('co-no-auto');
      const planApproval = session!.approvals.find((a) => a.type === 'plan');
      expect(planApproval).toBeDefined();
      expect(planApproval!.status).toBe('pending');
    });
  });
});

describe('consent covers every document it named, and only the plan in hand', () => {
  async function ask(
    sessionID: string,
    callID: string,
    storyId: string,
    files: Record<string, string>
  ): Promise<{ orchestrator: Awaited<ReturnType<typeof makeOrchestrator>>; questionText: string }> {
    const { evidenceOf, CONSENT_EVIDENCE_SCHEMA } = await import('../../src/app/consent.ts');
    const dir = join(directory, '.opencode/plan', storyId);
    mkdirSync(dir, { recursive: true });
    const refs: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
      refs.push(`.opencode/plan/${storyId}/${name}`);
    }
    const manifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: `Plan ${storyId}`,
      files: refs,
    } as const;
    const evidence = evidenceOf(manifest as unknown as ConsentManifest);
    const questionText = `<consent-request schema="harness.consent/v1" revision="1" evidence="${evidence}" grant="grant" decline="decline">${JSON.stringify(manifest)}</consent-request>`;
    const orchestrator = await makeOrchestrator();
    await orchestrator.before(sessionID, callID, questionText);
    return { orchestrator, questionText };
  }

  it('refuses a grant when a second consented document changed since the question', async () => {
    // The manifest may name several documents and only the first was ever
    // hashed, so editing another between the question and the answer changed
    // nothing the check could see: the consent was accepted and the workflow
    // moved on.
    const storyId = 'multi-file';
    await store.save(createSession('co-multi', 'base', 'state-machine'));
    const { orchestrator, questionText } = await ask('co-multi', 'call-multi', storyId, {
      'plan.md': '# Plan\n',
      'design.md': '# Design as reviewed\n',
    });

    writeFileSync(
      join(directory, '.opencode/plan', storyId, 'design.md'),
      '# Design, quietly rewritten\n'
    );

    await orchestrator.after(
      'co-multi',
      'call-multi',
      {},
      { title: 'Consent', output: questionText, metadata: { answers: ['grant'] } }
    );

    const session = await store.load('co-multi');
    expect(session!.approvals.some((a) => a.type === 'plan' && a.status === 'granted')).toBe(false);
  });

  it('grants when every consented document is untouched', async () => {
    await store.save(createSession('co-multi-ok', 'base', 'state-machine'));
    const { orchestrator, questionText } = await ask('co-multi-ok', 'call-ok', 'multi-ok', {
      'plan.md': '# Plan\n',
      'design.md': '# Design\n',
    });

    await orchestrator.after(
      'co-multi-ok',
      'call-ok',
      {},
      { title: 'Consent', output: questionText, metadata: { answers: ['grant'] } }
    );

    const session = await store.load('co-multi-ok');
    expect(session!.approvals.some((a) => a.type === 'plan' && a.status === 'granted')).toBe(true);
  });

  it('does not let a granted plan authorise the plan that replaced and was declined', async () => {
    // `before` pushed a second record while the first stayed `granted`, and
    // `refs[REF_PLAN]` was repointed at the new document straight away. A
    // decline removed only the pending one, so `session.approved('plan')`
    // stayed true — authority from a plan nobody was working on any more.
    await store.save(createSession('co-supersede', 'base', 'state-machine'));

    const first = await ask('co-supersede', 'call-first', 'plan-one', { 'plan.md': '# First\n' });
    await first.orchestrator.after(
      'co-supersede',
      'call-first',
      {},
      { title: 'Consent', output: first.questionText, metadata: { answers: ['grant'] } }
    );
    expect(
      (await store.load('co-supersede'))!.approvals.some(
        (a) => a.type === 'plan' && a.status === 'granted'
      )
    ).toBe(true);

    const second = await ask('co-supersede', 'call-second', 'plan-two', {
      'plan.md': '# Second\n',
    });
    await second.orchestrator.after(
      'co-supersede',
      'call-second',
      {},
      { title: 'Consent', output: second.questionText, metadata: { answers: ['decline'] } }
    );

    const session = await store.load('co-supersede');
    expect(session!.approvals.filter((a) => a.type === 'plan')).toHaveLength(0);
    expect(session!.refs.plan).toContain('plan-two');
  });
});
