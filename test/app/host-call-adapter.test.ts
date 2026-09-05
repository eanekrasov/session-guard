import { describe, it, expect } from 'vitest';
import {
  normaliseTool,
  admitHostCall,
  shouldBlockCall,
  persistHostBinding,
  type HostCall,
} from '../../src/app/host-call-adapter.ts';
import {
  dispatchCommand,
  genId,
  resetIdCounter,
  type WorkflowSnapshot,
} from '../../src/domain/workflow-model.ts';

function createReadySnapshot(): WorkflowSnapshot {
  resetIdCounter();
  const { snapshot } = dispatchCommand(
    null,
    { kind: 'create', definitionDigest: 'abc', title: 'test', input: {} },
    genId(),
    new Date().toISOString()
  );
  return snapshot!;
}

describe('normaliseTool', () => {
  it('passes known tools through', () => {
    expect(normaliseTool('Bash')).toBe('Bash');
    expect(normaliseTool('Write')).toBe('Write');
    expect(normaliseTool('Read')).toBe('Read');
  });

  it('rejects plugin tools', () => {
    expect(normaliseTool('workflow.tasks-get')).toBeNull();
    expect(normaliseTool('workflow.create')).toBeNull();
  });

  it('rejects unknown tools', () => {
    expect(normaliseTool('ls')).toBeNull();
    expect(normaliseTool('curl')).toBeNull();
  });
});

describe('admitHostCall', () => {
  it('admits a call to a ready execution', () => {
    const snapshot = createReadySnapshot();
    const call: HostCall = {
      tool: 'Bash',
      sessionID: 's1',
      callID: 'c1',
      args: { command: 'ls' },
    };

    const result = admitHostCall(call, snapshot);
    expect(result.admitted).toBe(true);
    if (result.admitted) {
      expect(result.binding.tool).toBe('Bash');
      expect(result.binding.execution.attemptId).toBeDefined();
    }
  });

  it('rejects unknown tools', () => {
    const snapshot = createReadySnapshot();
    const call: HostCall = {
      tool: 'ls',
      sessionID: 's1',
      callID: 'c1',
      args: {},
    };

    const result = admitHostCall(call, snapshot);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toContain('Unknown');
    }
  });

  it('rejects when no active scope exists', () => {
    const snapshot = createReadySnapshot();
    // Cancel the root scope
    const cancelled: WorkflowSnapshot = {
      ...snapshot,
      scopes: Object.fromEntries(
        Object.entries(snapshot.scopes).map(([k, v]) => [k, { ...v, status: 'cancelled' as const }])
      ),
    };

    const call: HostCall = { tool: 'Bash', sessionID: 's1', callID: 'c1', args: {} };
    const result = admitHostCall(call, cancelled);
    expect(result.admitted).toBe(false);
  });
});

describe('shouldBlockCall', () => {
  it('blocks write tools when decisions are pending', () => {
    const result = shouldBlockCall('Bash', 's1', [{ status: 'pending' }]);
    expect(result.block).toBe(true);
    expect(result.reason).toContain('pending');
  });

  it('does not block when no pending decisions', () => {
    const result = shouldBlockCall('Bash', 's1', []);
    expect(result.block).toBe(false);
  });

  it('does not block read tools', () => {
    const result = shouldBlockCall('Read', 's1', [{ status: 'pending' }]);
    expect(result.block).toBe(false);
  });
});

describe('persistHostBinding', () => {
  it('adds host binding to snapshot', () => {
    const snapshot = createReadySnapshot();
    const call: HostCall = { tool: 'Bash', sessionID: 's1', callID: 'c1', args: {} };
    const admission = admitHostCall(call, snapshot);
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    const updated = persistHostBinding(snapshot, 'opencode', 'native-s1', admission.binding);
    expect(Object.keys(updated.host.bindings)).toHaveLength(1);
    expect(updated.host.bindings[admission.binding.bindingId].status).toBe('admitted');
  });
});
