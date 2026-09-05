import type { WorkflowSession } from '../session/session-schema.ts';

/**
 * Approve a session action (plan, commit, etc.). Upsert by type — одна запись на тип.
 */
export function approve(
  session: WorkflowSession,
  type: string,
  evidence: string,
  callId: string
): void {
  const existing = session.approvals.find((a) => a.type === type);

  if (existing) {
    existing.status = 'granted';
    existing.grantedAt = new Date().toISOString();
    existing.evidence = evidence;
    existing.callId = callId;
    delete (existing as { feedback?: string }).feedback;
  } else {
    session.approvals.push({
      type,
      callId,
      status: 'granted',
      grantedAt: new Date().toISOString(),
      evidence,
    });
  }
}

/**
 * Decline a session action. Upsert by type — одна запись на тип.
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
