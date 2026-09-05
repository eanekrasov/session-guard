import { describe, it, expect } from 'vitest';
import {
  ResourceClaimsManager,
  isJoinComplete,
  createParallelScopes,
} from '../../src/domain/resource-claims.ts';

describe('ResourceClaimsManager', () => {
  it('acquires a shared claim when no existing claims', () => {
    const mgr = new ResourceClaimsManager();
    const { claims, conflicts } = mgr.acquire('scope-1', [
      { resourceKey: 'file-a', mode: 'shared' },
    ]);
    expect(claims).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    expect(claims[0].status).toBe('held');
    expect(claims[0].mode).toBe('shared');
  });

  it('allows two shared claims on the same resource', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'shared' }]);
    const { conflicts } = mgr.acquire('scope-2', [{ resourceKey: 'file-a', mode: 'shared' }]);
    expect(conflicts).toHaveLength(0);
  });

  it('blocks exclusive claim when shared claim is held', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'shared' }]);
    const { conflicts } = mgr.acquire('scope-2', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('cannot acquire exclusive');
  });

  it('blocks shared claim when exclusive claim is held', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    const { conflicts } = mgr.acquire('scope-2', [{ resourceKey: 'file-a', mode: 'shared' }]);
    expect(conflicts).toHaveLength(1);
  });

  it('blocks two exclusive claims on the same resource', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    const { conflicts } = mgr.acquire('scope-2', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    expect(conflicts).toHaveLength(1);
  });

  it('releases scope and frees resource for others', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    mgr.releaseScope('scope-1');
    const { conflicts } = mgr.acquire('scope-2', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    expect(conflicts).toHaveLength(0);
  });

  it('independent resources do not conflict', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    const { conflicts } = mgr.acquire('scope-2', [{ resourceKey: 'file-b', mode: 'exclusive' }]);
    expect(conflicts).toHaveLength(0);
  });

  it('quarantines all held claims', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    mgr.quarantineAll();
    expect(mgr.all().every((c) => c.status === 'quarantined')).toBe(true);
  });

  it('rebuilds from persisted list', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'exclusive' }]);
    const persisted = mgr.all();
    const mgr2 = new ResourceClaimsManager();
    mgr2.rebuild(persisted);
    expect(mgr2.count()).toBe(1);
    expect(mgr2.getHeld('file-a')).toHaveLength(1);
  });

  it('scopeHasClaims returns true when scope holds claims', () => {
    const mgr = new ResourceClaimsManager();
    mgr.acquire('scope-1', [{ resourceKey: 'file-a', mode: 'shared' }]);
    expect(mgr.scopeHasClaims('scope-1')).toBe(true);
    expect(mgr.scopeHasClaims('scope-2')).toBe(false);
  });
});

describe('structured concurrency helpers', () => {
  it('join is complete when all children finish', () => {
    const result = isJoinComplete([
      { id: 'c1', status: 'cancelled' },
      { id: 'c2', status: 'succeeded' },
    ]);
    expect(result.joined).toBe(true);
    expect(result.pending).toHaveLength(0);
  });

  it('join is not complete with active children', () => {
    const result = isJoinComplete([
      { id: 'c1', status: 'active' },
      { id: 'c2', status: 'succeeded' },
    ]);
    expect(result.joined).toBe(false);
    expect(result.pending).toEqual(['c1']);
  });

  it('createParallelScopes generates unique child IDs', () => {
    const result = createParallelScopes(2, 'parent-1', []);
    expect(result.childScopeIds).toHaveLength(2);
    expect(result.childScopeIds[0]).not.toBe(result.childScopeIds[1]);
  });
});
