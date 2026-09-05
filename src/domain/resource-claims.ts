/**
 * ResourceClaims — structured concurrency and shared/exclusive resource ownership.
 *
 * Resources are identified by opaque keys. Shared claims allow concurrent readers;
 * exclusive claims block any other claim on the same key. Claims are held per
 * execution scope and released on scope completion or explicit release.
 */

import { genId } from './workflow-model.ts';

export interface ResourceClaim {
  id: string;
  scopeId: string;
  resourceKey: string;
  mode: 'shared' | 'exclusive';
  status: 'held' | 'quarantined' | 'released';
}

export interface ResourceClaimRequest {
  resourceKey: string;
  mode: 'shared' | 'exclusive';
}

/**
 * ResourceClaimsManager manages concurrent access to named resources.
 *
 * Rules:
 * - Multiple shared claims on the same key are allowed.
 * - An exclusive claim on a key is allowed only when no other claim (shared or exclusive) is held.
 * - A shared claim on a key is allowed when only shared claims are held (no exclusive).
 * - Claims are released by scope or explicitly.
 */
export class ResourceClaimsManager {
  private claims: Map<string, ResourceClaim> = new Map();

  /**
   * Try to acquire claims for a scope. Returns acquired claims or rejects with reason.
   */
  acquire(
    scopeId: string,
    requests: ResourceClaimRequest[]
  ): { claims: ResourceClaim[]; conflicts: string[] } {
    const acquired: ResourceClaim[] = [];
    const conflicts: string[] = [];

    for (const req of requests) {
      const existing = this.getHeld(req.resourceKey);
      const canAcquire = canClaim(existing, req.mode);

      if (canAcquire) {
        const claim: ResourceClaim = {
          id: genId(),
          scopeId,
          resourceKey: req.resourceKey,
          mode: req.mode,
          status: 'held',
        };
        this.claims.set(claim.id, claim);
        acquired.push(claim);
      } else {
        const conflictingModes = existing.map((c) => c.mode).join(', ');
        conflicts.push(
          `Resource '${req.resourceKey}': cannot acquire ${req.mode} (existing: ${conflictingModes} by scopes [${existing.map((c) => c.scopeId).join(', ')}])`
        );
      }
    }

    return { claims: acquired, conflicts };
  }

  /**
   * Release all claims held by a scope.
   */
  releaseScope(scopeId: string): ResourceClaim[] {
    const released: ResourceClaim[] = [];
    for (const [id, claim] of this.claims) {
      if (claim.scopeId === scopeId && claim.status === 'held') {
        const updated: ResourceClaim = { ...claim, status: 'released' };
        this.claims.set(id, updated);
        released.push(updated);
      }
    }
    return released;
  }

  /**
   * Release a single claim.
   */
  release(claimId: string): ResourceClaim | null {
    const claim = this.claims.get(claimId);
    if (!claim || claim.status !== 'held') return null;
    const updated: ResourceClaim = { ...claim, status: 'released' };
    this.claims.set(claimId, updated);
    return updated;
  }

  /**
   * Get all held claims for a resource key.
   */
  getHeld(resourceKey: string): ResourceClaim[] {
    return this.all().filter((c) => c.resourceKey === resourceKey && c.status === 'held');
  }

  /**
   * Check if a scope holds any claims.
   */
  scopeHasClaims(scopeId: string): boolean {
    return this.all().some((c) => c.scopeId === scopeId && c.status === 'held');
  }

  /**
   * Quarantine all claims (on crash recovery).
   */
  quarantineAll(): void {
    for (const [id, claim] of this.claims) {
      if (claim.status === 'held') {
        this.claims.set(id, { ...claim, status: 'quarantined' });
      }
    }
  }

  /**
   * Rebuild from a persisted list (on recovery).
   */
  rebuild(claims: ResourceClaim[]): void {
    this.claims.clear();
    for (const c of claims) {
      this.claims.set(c.id, c);
    }
  }

  all(): ResourceClaim[] {
    return Array.from(this.claims.values());
  }

  count(): number {
    return this.claims.size;
  }
}

function canClaim(existing: ResourceClaim[], requestedMode: 'shared' | 'exclusive'): boolean {
  if (existing.length === 0) return true;
  if (requestedMode === 'exclusive') return false; // Any existing blocks exclusive
  // Shared is allowed only if no exclusive is held
  return existing.every((c) => c.mode === 'shared');
}

/**
 * Create scope-based child scopes for structured concurrency.
 * A scope with child scopes does not complete until all children have completed.
 */
export function createChildScopes(scopeIds: string[]): string[] {
  return scopeIds.map(() => genId());
}

/**
 * Check whether a join condition is satisfied: all child scopes must be completed.
 */
export function isJoinComplete(childScopeStatuses: Array<{ id: string; status: string }>): {
  joined: boolean;
  pending: string[];
} {
  const pending = childScopeStatuses.filter((s) => s.status === 'active').map((s) => s.id);
  return { joined: pending.length === 0, pending };
}

/**
 * Structured concurrency: parallel scope creation.
 *
 * Returns child scope IDs that must all complete before the parent can advance.
 */
export function createParallelScopes(
  count: number,
  parentScopeId: string,
  existingChildren: string[]
): { childScopeIds: string[] } {
  const childScopeIds = createChildScopes(
    Array.from({ length: count }, (_, i) => `${parentScopeId}/child-${i}`)
  );
  return { childScopeIds: [...existingChildren, ...childScopeIds] };
}
