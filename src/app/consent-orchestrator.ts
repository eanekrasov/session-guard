import { resolve } from 'node:path';
import { WorkflowStore } from '../session/session-store.ts';
import { SessionQueue } from './session-queue.ts';
import {
  parseConsentRequest,
  evidenceOf,
  calculatePlanEvidence as calculateDocumentEvidence,
  classifyConsentAnswer,
} from './consent.ts';
import type { LogFn } from './logger.ts';
import { approve } from '../domain/approvals.ts';
import { REF_PLAN, type Approval } from '../session/session-schema.ts';
import { readFile } from './sdd-artifacts.ts';
import type { SessionClient } from './runtime-types.ts';

// ─── ConsentOrchestrator ─────────────────────────────────────────────────────

/**
 * Owns the Question-tool consent lifecycle: parsing a consent-request tag
 * before the question is shown, verifying plan-file evidence, and
 * classifying the user's answer after it comes back.
 */
export class ConsentOrchestrator {
  private log: LogFn;

  constructor(
    private readonly store: WorkflowStore,
    private readonly queue: SessionQueue,
    private readonly projectDir: string,
    private readonly profilesDir: string,
    private readonly client: SessionClient,
    log?: LogFn
  ) {
    this.log = log ?? (() => Promise.resolve());
  }

  /**
   * Parse a consent request from question text and verify plan integrity.
   * If the question contains a consent-request tag, validate it and store a
   * pending approval record on the session.
   *
   * I/O (readPlanFile, client.session.messages) is performed BEFORE
   * queue.enqueue to avoid blocking the session lock with I/O.
   */
  async before(sessionID: string, callID: string, questionText: string): Promise<void> {
    const consentRequest = parseConsentRequest(questionText);
    if (!consentRequest) return;

    // Verify manifest evidence matches (pure — no I/O)
    const computedEvidence = evidenceOf(consentRequest.manifest);
    if (computedEvidence !== consentRequest.evidence) return;

    // SDK-004: Read session messages to verify the question context
    // (e.g., confirm the question was actually shown to the user).
    try {
      const messages = await this.client.messages({ path: { id: sessionID }, query: { limit: 5 } });
      // SDK возвращает discriminated union: { data: T; error: undefined } | { data: undefined; error: E }
      // Проверяем, что data не undefined.
      if (!('data' in messages) || !messages.data) return;
      // TODO: SDK Part union не имеет поля `status` на text-варианте.
      // Проверяем status только если он есть (другие Part могут его иметь).
      const hasRelevantPart = messages.data.some((msg) =>
        msg.parts.some((p) => p.type === 'text' && (!('status' in p) || p.status !== 'failed'))
      );
      if (!hasRelevantPart) return;
    } catch (err) {
      void this.log('warn', 'consentBefore: client.messages unavailable, falling through', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    void this.log('info', `Consent request detected`, {
      callID,
      sessionID,
      revision: consentRequest.revision,
      summary: consentRequest.manifest.summary,
    });

    // Resolve plan path and read plan file BEFORE enqueue
    const documentRef =
      consentRequest.manifest.files.find((f) => f.includes('plan') && f.endsWith('plan.md')) ??
      consentRequest.manifest.files[0];

    if (!documentRef) return;

    const documentPath = resolve(this.projectDir, documentRef);
    const documentContent = readFile(documentPath);
    if (documentContent === null) return;

    const documentEvidence = calculateDocumentEvidence(documentContent);

    await this.queue.enqueue(sessionID, async (session) => {
      if (!session) return;

      // Dedup: already consented for this callID
      if (session.consentedCallIDs.includes(callID)) return;

      session.approvals.push({
        type: 'plan',
        callId: callID,
        status: 'pending',
        evidence: documentEvidence,
      });
      session.refs[REF_PLAN] = documentPath;
      session.consentedCallIDs = [...session.consentedCallIDs, callID];

      // P1-015: HARNESS_AUTO_APPROVE — auto-approve plan if env var is set
      // and the plan hasn't been approved yet.
      if (
        process.env.HARNESS_AUTO_APPROVE === 'true' &&
        !session.approvals.some((a) => a.type === 'plan' && a.status === 'granted')
      ) {
        approve(session, 'plan', documentEvidence, callID);
        void this.log('info', 'HARNESS_AUTO_APPROVE: plan auto-approved', {
          sessionID,
          callID,
          evidence: documentEvidence.slice(0, 16),
        });
      }
    });
  }

  /**
   * P1-015: Verify that the plan file evidence hasn't changed between when the
   * question was shown and when the user answers. Re-reads the plan file and
   * compares its evidence hash against the one stored at question time.
   *
   * Returns `true` when evidence still matches (or when re-read fails — fail
   * closed to prevent approving a stale plan). Returns `false` when evidence
   * has changed.
   */
  private verifyPlanEvidenceAtDecision(
    session: {
      refs?: Record<string, string>;
      approvals?: Approval[];
    },
    callID: string,
    sessionID?: string
  ): boolean {
    const documentRef = session.refs?.[REF_PLAN];
    const pendingApproval = this.findOpenApproval(session.approvals ?? [], callID);
    if (!documentRef || !pendingApproval?.evidence) {
      void this.log('warn', `verifyPlanEvidenceAtDecision: missing ref or evidence`, {
        sessionID,
        callID,
        hasRef: !!documentRef,
        hasEvidence: !!pendingApproval?.evidence,
      });
      return false;
    }

    const documentPath = resolve(this.projectDir, documentRef);
    const documentContent = readFile(documentPath);
    if (documentContent === null) {
      void this.log('warn', `verifyPlanEvidenceAtDecision: plan file not found`, {
        sessionID,
        callID,
        documentRef,
        resolvedPath: documentPath,
      });
      return false;
    }

    const currentEvidence = calculateDocumentEvidence(documentContent);
    const match = currentEvidence === pendingApproval.evidence;

    if (!match) {
      void this.log(
        'warn',
        `verifyPlanEvidenceAtDecision: evidence mismatch — plan changed since question was shown`,
        {
          sessionID,
          callID,
          documentRef,
          resolvedPath: documentPath,
          previous: pendingApproval.evidence.slice(0, 16),
          current: currentEvidence.slice(0, 16),
        }
      );
    }

    return match;
  }

  private findOpenApproval(approvals: Approval[], callID: string): Approval | undefined {
    return approvals.find(
      (approval) =>
        approval.type === 'plan' && approval.callId === callID && approval.status === 'pending'
    );
  }

  private removeOpenApproval(session: { approvals?: Approval[] }, callID: string): void {
    session.approvals = (session.approvals ?? []).filter(
      (approval) =>
        !(approval.type === 'plan' && approval.callId === callID && approval.status === 'pending')
    );
  }

  /**
   * Classify the consent answer and update the session.
   * On grant, verifies plan evidence at decision time, then injects a
   * synthetic message via client.session.prompt().
   */
  async after(
    sessionID: string,
    callID: string,
    args: unknown,
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    let wasGranted = false;
    let evidence = '';

    void this.log('info', `Consent after: processing answer`, { sessionID, callID });

    await this.queue.enqueue(sessionID, async (session) => {
      if (!session) return;
      const pendingApproval = this.findOpenApproval(session.approvals, callID);
      if (!pendingApproval) return;

      // Extract user answer from output metadata
      const answers: string[] = [];
      if (output.metadata && typeof output.metadata === 'object') {
        const meta = output.metadata as Record<string, unknown>;
        if (Array.isArray(meta.answers)) {
          answers.push(...meta.answers.map(String));
        }
        if (typeof meta.answer === 'string') {
          answers.push(meta.answer);
        }
      }

      const request = parseConsentRequest(output.output ?? '');
      if (!request) return;

      const result = classifyConsentAnswer(answers, request);

      if (result.kind === 'grant') {
        // P1-015: Re-verify plan evidence at decision time
        if (!this.verifyPlanEvidenceAtDecision(session, callID, sessionID)) {
          this.removeOpenApproval(session, callID);
          session.refs[REF_PLAN] = '';
          void this.store.save(session);
          return;
        }

        approve(session, 'plan', pendingApproval.evidence ?? '', callID);
        wasGranted = true;
        evidence = pendingApproval.evidence ?? '';
        void this.log('info', `Consent granted: plan approved`, {
          sessionID,
          callID,
          evidence: evidence.slice(0, 16),
        });
      } else {
        void this.log('info', `Consent: plan declined or unrecognized`, {
          sessionID,
          callID,
          kind: result.kind,
        });
      }

      if (result.kind !== 'grant') {
        this.removeOpenApproval(session, callID);
      }
    });

    // SDK-004: Inject synthetic message on grant (outside enqueue — I/O after lock released)
    if (wasGranted) {
      try {
        await this.client.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: 'text',
                text: `Plan approved with evidence ${evidence}.`,
              },
            ],
          },
        });
      } catch (err) {
        void this.log('warn', 'consentAfter: prompt injection failed — session already updated', {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
