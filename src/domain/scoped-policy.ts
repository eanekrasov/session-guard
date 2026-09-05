/**
 * ScopedPolicy — subject-versioned decisions, checks, and evidence.
 *
 * Replaces session-wide approval upsert and independent verification stores
 * with versioned, execution-bound records.
 */

import { genId, type ExecutionRef, type VersionRef, type CheckReport } from './workflow-model.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PolicyDefinition {
  id: string;
  authority: 'human' | 'policy';
  allowedActors: string[];
  outcomes: string[];
  onInvalidated: string;
  onExpired: string;
}

export interface SubjectVersion {
  subject: string;
  version: string;
}

export interface ScopedDecision {
  id: string;
  execution: ExecutionRef;
  purpose: 'step' | 'retry';
  subjects: SubjectVersion[];
  policy: PolicyDefinition;
  status: 'pending' | 'resolved' | 'invalidated' | 'expired' | 'revoked';
  resolution: {
    outcome: string;
    parameters: Record<string, unknown>;
    resolverId: string;
    authority: 'human' | 'policy';
    revision: number;
  } | null;
  createdAt: string;
}

export interface CheckDefinition {
  id: string;
  acceptedOutcomes: string[];
  acceptedAuthorities: Array<'assertion' | 'verification'>;
  allowEmptySubjects: boolean;
}

export interface EvidenceRecord {
  id: string;
  execution: ExecutionRef;
  role: 'baseline' | 'observed';
  artifactVersions: VersionRef[];
  recordedRevision: number;
}

// ─── Decision store ──────────────────────────────────────────────────────────

export class ScopedDecisionStore {
  private decisions: Map<string, ScopedDecision> = new Map();

  add(decision: ScopedDecision): void {
    this.decisions.set(decision.id, decision);
  }

  get(id: string): ScopedDecision | undefined {
    return this.decisions.get(id);
  }

  all(): ScopedDecision[] {
    return Array.from(this.decisions.values());
  }

  pending(execution: ExecutionRef): ScopedDecision[] {
    return this.all().filter(
      (d) =>
        d.execution.scopeId === execution.scopeId &&
        d.execution.executionId === execution.executionId &&
        d.status === 'pending'
    );
  }

  /**
   * Resolve a pending decision. Validates resolver authority and subject versions.
   */
  resolve(
    id: string,
    outcome: string,
    resolverId: string,
    authority: 'human' | 'policy',
    revision: number,
    parameters: Record<string, unknown> = {}
  ): ScopedDecision | null {
    const decision = this.decisions.get(id);
    if (!decision) return null;
    if (decision.status !== 'pending') return null;

    // Validate authority
    if (authority === 'human' && decision.policy.authority === 'policy') {
      return null; // Policy-only decision cannot be resolved by human shortcut
    }
    if (authority === 'policy' && decision.policy.authority === 'human') {
      // Policy can still propose, but not override human authority
    }

    // Validate outcome
    if (!decision.policy.outcomes.includes(outcome)) return null;

    const resolved: ScopedDecision = {
      ...decision,
      status: 'resolved',
      resolution: { outcome, parameters, resolverId, authority, revision },
    };
    this.decisions.set(id, resolved);
    return resolved;
  }

  /**
   * Invalidate decisions whose subjects have changed.
   */
  invalidate(changedSubjects: SubjectVersion[]): ScopedDecision[] {
    const invalidated: ScopedDecision[] = [];
    for (const [id, decision] of this.decisions) {
      if (decision.status !== 'pending') continue;
      const subjectChanged = changedSubjects.some((cs) =>
        decision.subjects.some((ds) => ds.subject === cs.subject && ds.version !== cs.version)
      );
      if (subjectChanged) {
        const updated: ScopedDecision = {
          ...decision,
          status: 'invalidated',
          resolution: {
            outcome: decision.policy.onInvalidated,
            parameters: {},
            resolverId: 'system',
            authority: 'policy',
            revision: -1,
          },
        };
        this.decisions.set(id, updated);
        invalidated.push(updated);
      }
    }
    return invalidated;
  }

  /**
   * Expire decisions that exceed a time limit.
   */
  expire(before: string): ScopedDecision[] {
    const expired: ScopedDecision[] = [];
    for (const [id, decision] of this.decisions) {
      if (decision.status !== 'pending') continue;
      if (decision.createdAt < before) {
        const updated: ScopedDecision = {
          ...decision,
          status: 'expired',
          resolution: {
            outcome: decision.policy.onExpired,
            parameters: {},
            resolverId: 'system',
            authority: 'policy',
            revision: -1,
          },
        };
        this.decisions.set(id, updated);
        expired.push(updated);
      }
    }
    return expired;
  }
}

// ─── Check verifier ──────────────────────────────────────────────────────────

/**
 * Verify that a check report is valid against its definition and subjects.
 */
export function validateCheck(
  report: CheckReport,
  definition: CheckDefinition,
  subjects: VersionRef[]
): { valid: boolean; reason?: string } {
  if (!definition.acceptedOutcomes.includes(report.outcome)) {
    return {
      valid: false,
      reason: `Outcome '${report.outcome}' not accepted by check '${definition.id}'`,
    };
  }
  if (!definition.allowEmptySubjects && report.subjects.length === 0) {
    return { valid: false, reason: `Check '${definition.id}' requires subjects but none provided` };
  }
  // All report subjects must exist in the execution subjects
  const subjectKeys = new Set(subjects.map((s) => `${s.id}:${s.version}`));
  for (const rs of report.subjects) {
    if (!subjectKeys.has(`${rs.id}:${rs.version}`)) {
      return { valid: false, reason: `Subject ${rs.id}:${rs.version} not in execution subjects` };
    }
  }
  return { valid: true };
}
