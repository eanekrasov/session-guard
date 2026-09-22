import type { WorkflowSession } from '../session/session-schema.ts';

/**
 * Одобрить действие сессии (plan, commit и т.д.). Upsert по типу — одна запись на тип.
 */
export function approve(
  session: WorkflowSession,
  type: string,
  evidence: string,
  callId: string,
  now: string = new Date().toISOString()
): void {
  const existing = session.approvals.find((a) => a.type === type);

  if (existing) {
    existing.status = 'granted';
    existing.grantedAt = now;
    existing.evidence = evidence;
    existing.callId = callId;
    delete (existing as { feedback?: string }).feedback;
  } else {
    session.approvals.push({
      type,
      callId,
      status: 'granted',
      grantedAt: now,
      evidence,
    });
  }
}

/**
 * Отклонить действие сессии. Upsert по типу — одна запись на тип.
 */
export function decline(
  session: WorkflowSession,
  type: string,
  evidence: string,
  callId: string,
  feedback: string
): void {
  const existing = session.approvals.find((a) => a.type === type);

  if (existing) {
    existing.status = 'denied';
    existing.evidence = evidence;
    existing.feedback = feedback;
    existing.callId = callId;
  } else {
    session.approvals.push({
      type,
      callId,
      status: 'denied',
      evidence,
      feedback,
    });
  }
}
