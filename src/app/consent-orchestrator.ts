import { resolve } from 'node:path';
import { WorkflowStore } from '../session/session-store.ts';
import { SessionExecutor } from './session-executor.ts';
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

export interface ConsentSessionCapabilities {
  readonly hasMessageContext?: (sessionID: string) => Promise<boolean>;
  readonly prompt?: SessionClient['prompt'];
}

// ─── ConsentOrchestrator ─────────────────────────────────────────────────────

/**
 * Владение lifecycle согласия Question-tool: парсинг тега consent-request
 * до показа вопроса, верификация доказательств план-файла, и классификация
 * ответа пользователя после его возвращения.
 */
export class ConsentOrchestrator {
  private log: LogFn;

  constructor(
    private readonly store: WorkflowStore,
    private readonly executor: SessionExecutor,
    private readonly projectDir: string,
    private readonly profilesDir: string,
    private readonly client: ConsentSessionCapabilities | undefined,
    log?: LogFn
  ) {
    this.log = log ?? (() => Promise.resolve());
  }

  /**
   * Распарсить запрос согласия из текста вопроса и проверить целостность плана.
   * Если вопрос содержит тег consent-request, валидировать его и сохранить
   * запись pending approval в сессию.
   *
   * I/O (readPlanFile, client.session.messages) выполняется ДО
   * queue.enqueue чтобы не блокировать лок сессии с I/O.
   */
  async before(sessionID: string, callID: string, questionText: string): Promise<void> {
    const consentRequest = parseConsentRequest(questionText);
    if (!consentRequest) return;

    // Verify manifest evidence matches (pure — no I/O)
    const computedEvidence = evidenceOf(consentRequest.manifest);
    if (computedEvidence !== consentRequest.evidence) return;

    // SDK-004: Прочитать сообщения сессии чтобы проверить контекст вопроса
    // (например, подтвердить что вопрос действительно показывался пользователю).
    try {
      if (!(await this.client?.hasMessageContext?.(sessionID))) return;
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

    // Разрешить и прочитать каждый документ, который называет манифест, ДО enqueue.
    // Читался и хешировался только первый, так что второй документ, отредактированный
    // между вопросом и ответом, был невидим и согласие проходило.
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

    // Основной документ — тот, что показан оператору; доказательство — над каждым
    // файлом, который назвал манифест.
    const documentRef =
      documentRefs.find((f) => f.includes('plan') && f.endsWith('plan.md')) ?? documentRefs[0]!;
    const documentPath = resolve(this.projectDir, documentRef);
    const documentEvidence = calculateDocumentSetEvidence(documents);
    const consentType = consentTypeOf(consentRequest.manifest);

    await this.executor.run(sessionID, async (tx) => {
      if (!tx.session) return;

      // Dedup: already consented for this callID
      if (tx.session.consentedCallIDs.includes(callID)) return;

      // One record per type. `approve` и `decline` оба upsert по типу, поэтому
      // вторая запись заставляла их обновлять не ту — и, что хуже, стоящий
      // `granted` от более раннего документа выживал после decline этого,
      // пока `refs[<type>]` уже был переустановлен на новый документ. Каждый
      // `session.approved(<type>)` гард тогда проходил на авторизации, которой
      // никто не давал для работы на руках.
      //
      // Снова спросить — отозвать стоящий вердикт, что честно: документ в
      // обсуждении изменился.
      //
      // Отзыв по `consentType`, а не по литеральному имени. Раньше читало
      // `!== 'plan'`, так что согласие под любым другим именем никогда не
      // отзывалось: новая pending запись присоединялась к стоящей той же
      // типа, `approve` находила первую и оставляла вторую pending, и
      // `approved(<type>)` оставалось true на авторизации, данной для
      // старого документа.
      tx.session.approvals = tx.session.approvals.filter(
        (approval) => approval.type !== consentType
      );
      tx.session.approvals.push({
        type: consentType,
        callId: callID,
        status: 'pending',
        evidence: documentEvidence,
        files: documentRefs,
      });
      // Ссылка на документ живёт под именем согласия: `refs.plan` для плана,
      // `refs.deploy` для деплоя. Guard-ы схемы уже читают `session.refs.<имя>`
      // обобщённо — писала под одним именем только эта строка.
      tx.session.refs[consentType] = documentPath;
      tx.session.consentedCallIDs = [...tx.session.consentedCallIDs, callID];

      // P1-015: HARNESS_AUTO_APPROVE — авто-одобрение для прогонов без
      // оператора. Одобряет ровно то согласие, которое спросили, а не всегда
      // план: иначе схема с двумя разными согласиями не проезжает.
      if (
        process.env.HARNESS_AUTO_APPROVE === 'true' &&
        !tx.session.approvals.some((a) => a.type === consentType && a.status === 'granted')
      ) {
        approve(tx.session, consentType, documentEvidence, callID, new Date().toISOString());
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
   * P1-015: Проверить, что доказательства план-файла не изменились между
   * показом вопроса и ответом пользователя. Перечитывает план-файл и сравнивает
   * его хеш доказательств с тем, что хранился во время вопроса.
   *
   * Возвращает `true` когда доказательства всё ещё совпадают (или когда
   * перечтение фейлит — fail closed чтобы не одобрить старый план).
   * Возвращает `false` когда доказательства изменились.
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
    // Только список файлов самого манифеста. Раньше был фоллбек на
    // `refs.plan` здесь, для записей, написанных до того, как список существовал —
    // но он читал план-документ какой бы consent ни решался, так что согласие
    // под другим именом верифицировалось против файла, которое оно никогда не
    // называло. Записи, которые могут попасть сюда — это pending те, которые
    // этот оркестратор засунул во время вопроса, и они всегда несут `files`;
    // approval без одного — запись, которую тут никто не может верифицировать,
    // и она фейлит закрыто ниже.
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
   * Классифицировать ответ согласия и обновить сессию.
   * При гранте, верифицирует доказательства плана в момент решения, затем
   * инжектит синтетическое сообщение через client.session.prompt().
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

    await this.executor.run(sessionID, async (tx) => {
      if (!tx.session) return;
      const pendingApproval = this.findOpenApproval(tx.session.approvals, callID);
      if (!pendingApproval) return;

      // Извлечь ответ пользователя из метаданных output
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

      // Тег в вопросе, который спрашивали, а не в ответе, который пришёл
      // обратно. `output.output` оставлен как фоллбек для хостов, которые его эхают.
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
        if (!this.verifyPlanEvidenceAtDecision(tx.session, callID, sessionID)) {
          this.removeOpenApproval(tx.session, callID);
          tx.session.refs[pendingApproval.type] = '';
          // Enclosing executor.run() handles the save — no direct store.save here.
          return;
        }

        // Одобряется то согласие, которое спрашивали. Здесь стояло литеральное
        // 'plan', и схема с `consent: deploy` получала одобрение с чужим
        // именем — переход ждал своего и не дожидался никогда.
        approve(
          tx.session,
          pendingApproval.type,
          pendingApproval.evidence ?? '',
          callID,
          new Date().toISOString()
        );
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
        this.removeOpenApproval(tx.session, callID);
      }
    });

    // SDK-004: Инжектить синтетическое сообщение при гранте (снаружи enqueue — I/O после освобождения лка)
    if (wasGranted) {
      try {
        if (!this.client?.prompt) return;
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
