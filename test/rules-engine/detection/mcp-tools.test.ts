import { describe, it, expect } from 'bun:test';
import { extractConnectedMcpCapabilityIDs } from '../../../src/rules-engine/detection/mcp-tools.js';
import * as mcpTools from '../../../src/rules-engine/detection/mcp-tools.js';

describe('mcp-tools runtime exports', () => {
  it('exports only extractConnectedMcpCapabilityIDs at runtime', () => {
    const exportedKeys = Object.keys(mcpTools).sort();
    expect(exportedKeys).toEqual(['extractConnectedMcpCapabilityIDs']);
  });
});

describe('extractConnectedMcpCapabilityIDs', () => {
  it('returns mcp_<sanitizedName> for connected servers', () => {
    const status = {
      context7: { status: 'connected' },
      'my server': { status: 'connected' },
      disabled: { status: 'disabled' },
      disconnected: { status: 'disconnected' },
    };

    expect(extractConnectedMcpCapabilityIDs(status)).toEqual(['mcp_context7', 'mcp_my_server']);
  });

  it('accepts v2 server lists and wrapped data lists', () => {
    const servers = [
      { name: 'context7', status: { status: 'connected' } },
      { name: 'my server', status: { status: 'connected' } },
      { name: 'disabled', status: { status: 'disabled' } },
    ];

    expect(extractConnectedMcpCapabilityIDs(servers)).toEqual(['mcp_context7', 'mcp_my_server']);
    expect(extractConnectedMcpCapabilityIDs({ data: servers })).toEqual([
      'mcp_context7',
      'mcp_my_server',
    ]);
  });

  it('ignores malformed v2 list entries', () => {
    expect(
      extractConnectedMcpCapabilityIDs([
        null,
        { name: 42, status: { status: 'connected' } },
        { name: 'missing-status' },
        { name: 'array-status', status: ['connected'] },
      ])
    ).toEqual([]);
  });

  it('returns [] for null/undefined/non-object', () => {
    expect(extractConnectedMcpCapabilityIDs(null)).toEqual([]);
    expect(extractConnectedMcpCapabilityIDs(undefined)).toEqual([]);
    expect(extractConnectedMcpCapabilityIDs('nope')).toEqual([]);
  });

  it('ignores entries without status.connected', () => {
    const status = { context7: { status: 'failed' } };
    expect(extractConnectedMcpCapabilityIDs(status)).toEqual([]);
  });
});
