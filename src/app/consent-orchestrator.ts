import { resolve } from 'node:path';
import { WorkflowStore } from '../session/session-store.ts';
import { SessionQueue } from './session-queue.ts';
import {
  parseConsentRequest,
  evidenceOf,
  calculateDocumentSetEvidence,
  classifyConsentAnswer,
  consentTypeOf,
  questionTextOf,
  DEFAULT_CONSENT_TYPE,
} from './consent.ts';
import type { LogFn } from './logger.ts';
import { approve } from '../domain/approvals.ts';
import { type Approval } from '../session/session-schema.ts';
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

    // Resolve and read every document the manifest names, BEFORE enqueue.
    // Only the first was read and hashed, so a second document edited between
    // the question and the answer was invisible and the consent went through.
    const documentRefs = [...consentRequest.manifest.files];
    if (documentRefs.length === 0) return;

    const documents: Array<[string, string]> = [];
    for (const ref of documentRefs) {
      const content = readFile(resolve(this.projectDir, ref));
      if (content === null) {
        void this.log('warn', 'consentBefore: a document the manifest names is missing', {
          sessionID,
          callID,
          ref,
        });
        return;
      }
      documents.push([ref, content]);
    }

    // The primary document is the one shown to the operator; the evidence
    // is over every file the manifest named.
    const documentRef =
      documentRefs.find((f) => f.includes('plan') && f.endsWith('plan.md')) ?? documentRefs[0]!;
    const documentPath = resolve(this.projectDir, documentRef);
    const documentEvidence = calculateDocumentSetEvidence(documents);
    const consentType = consentTypeOf(consentRequest.manifest);

    await this.queue.enqueue(sessionID, async (session) => {
      if (!session) return;

      // Dedup: already consented for this callID
      if (session.consentedCallIDs.includes(callID)) return;

      // One record per type. `approve` and `decline` both upsert by type, so a
      // second record left them updating the wrong one — and, worse, a
      // standing `granted` from an earlier document survived a decline of this
      // one while `refs[<type>]` had already been repointed at the new
      // document. Every `session.approved(<type>)` guard then passed on
      // authority nobody had given for the work in hand.
      //
      // Asking again withdraws the standing verdict, which is the honest
      // reading: the document under discussion has changed.
      //
      // The withdrawal is by `consentType`, not by a literal name. It used to
      // read `!== 'plan'`, so a consent under any other name was never
      // withdrawn: the new pending record joined a standing one of the same
      // type, `approve` found the first and left the second pending, and
      // `approved(<type>)` stayed true on authority given for an older
      // document.
      session.approvals = session.approvals.filter((approval) => approval.type !== consentType);
      session.approvals.push({
        type: consentType,
        callId: callID,
        status: 'pending',
        evidence: documentEvidence,
        files: documentRefs,
      });
      // Ссылка на документ живёт под именем согласия: `refs.plan` для плана,
      // `refs.deploy` для деплоя. Guard-ы схемы уже читают `session.refs.<имя>`
      // обобщённо — писала под одним именем только эта строка.
      session.refs[consentType] = documentPath;
      session.consentedCallIDs = [...session.consentedCallIDs, callID];

      // P1-015: HARNESS_AUTO_APPROVE — авто-одобрение для прогонов без
      // оператора. Одобряет ровно то согласие, которое спросили, а не всегда
      // план: иначе схема с двумя разными согласиями не проезжает.
      if (
        process.env.HARNESS_AUTO_APPROVE === 'true' &&
        !session.approvals.some((a) => a.type === consentType && a.status === 'granted')
      ) {
        approve(session, consentType, documentEvidence, callID);
        void this.log('info', 'HARNESS_AUTO_APPROVE: consent auto-approved', {
          sessionID,
          callID,
          type: consentType,
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
    const pendingApproval = this.findOpenApproval(session.approvals ?? [], callID);
    // Only the manifest's own file list. There used to be a fallback to
    // `refs.plan` here, for records written before the list existed — but it
    // read the plan document whatever consent was being decided, so a consent
    // under another name was verified against a file it never named. Records
    // this can reach are the pending ones this orchestrator pushed at question
    // time, and those always carry `files`; an approval without one is a
    // record nothing here can verify, and it fails closed below.
    const documentRefs = pendingApproval?.files ?? [];
    const documentRef = documentRefs[0];
    if (!documentRef || !pendingApproval?.evidence) {
      void this.log('warn', `verifyPlanEvidenceAtDecision: missing ref or evidence`, {
        sessionID,
        callID,
        hasRef: !!documentRef,
        hasEvidence: !!pendingApproval?.evidence,
      });
      return false;
    }

    const documents: Array<[string, string]> = [];
    for (const ref of documentRefs) {
      const path = resolve(this.projectDir, ref);
      const content = readFile(path);
      if (content === null) {
        void this.log('warn', `verifyPlanEvidenceAtDecision: a consented file is missing`, {
          sessionID,
          callID,
          documentRef: ref,
          resolvedPath: path,
        });
        return false;
      }
      documents.push([ref, content]);
    }

    const documentPath = resolve(this.projectDir, documentRef);
    const currentEvidence = calculateDocumentSetEvidence(documents);
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

  /**
   * Незакрытая запись согласия этого вызова.
   *
   * Ищется по `callId`, а не по типу: идентификатор вызова и так уникален, а
   * фильтр `type === 'plan'` делал невидимым любое согласие с другим именем —
   * запись создавалась и оставалась висеть вечно.
   */
  private findOpenApproval(approvals: Approval[], callID: string): Approval | undefined {
    return approvals.find(
      (approval) => approval.callId === callID && approval.status === 'pending'
    );
  }

  private removeOpenApproval(session: { approvals?: Approval[] }, callID: string): void {
    session.approvals = (session.approvals ?? []).filter(
      (approval) => !(approval.callId === callID && approval.status === 'pending')
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
    let grantedType = DEFAULT_CONSENT_TYPE;

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

      // The tag is in the question that was asked, not in the answer that came
      // back. `output.output` is kept as a fallback for hosts that echo it.
      const request =
        parseConsentRequest(questionTextOf(args)) ?? parseConsentRequest(output.output ?? '');
      if (!request) {
        void this.log('warn', 'Consent after: no consent request found in the question', {
          sessionID,
          callID,
        });
        return;
      }

      const result = classifyConsentAnswer(answers, request);

      if (result.kind === 'grant') {
        // P1-015: Re-verify plan evidence at decision time
        if (!this.verifyPlanEvidenceAtDecision(session, callID, sessionID)) {
          this.removeOpenApproval(session, callID);
          session.refs[pendingApproval.type] = '';
          void this.store.save(session);
          return;
        }

        // Одобряется то согласие, которое спрашивали. Здесь стояло литеральное
        // 'plan', и схема с `consent: deploy` получала одобрение с чужим
        // именем — переход ждал своего и не дожидался никогда.
        approve(session, pendingApproval.type, pendingApproval.evidence ?? '', callID);
        wasGranted = true;
        grantedType = pendingApproval.type;
        evidence = pendingApproval.evidence ?? '';
        void this.log('info', `Consent granted`, {
          sessionID,
          callID,
          type: pendingApproval.type,
          evidence: evidence.slice(0, 16),
        });
      } else {
        void this.log('info', `Consent declined or unrecognized`, {
          sessionID,
          callID,
          type: pendingApproval.type,
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
                text: `Consent '${grantedType}' approved with evidence ${evidence}.`,
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
