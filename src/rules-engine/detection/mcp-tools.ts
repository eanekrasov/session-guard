function sanitizeMcpClientName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromStatusList(servers: readonly unknown[]): string[] {
  const capabilityIDs: string[] = [];
  for (const server of servers) {
    if (!isRecord(server)) continue;
    const fields = server;
    const status = fields.status;
    // v2 tags McpServer.status as an object ({ status: 'connected' }); the
    // plain-string form is accepted defensively.
    const statusValue = isRecord(status) ? status.status : status;
    if (statusValue !== 'connected') continue;
    const name = fields.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const sanitized = sanitizeMcpClientName(name);
    if (sanitized) {
      capabilityIDs.push(`mcp_${sanitized}`);
    }
  }
  return capabilityIDs;
}

// Accepts both the v1 map form and the v2 McpServer[] form so the legacy
// map path keeps working where it is still supplied.
export function extractConnectedMcpCapabilityIDs(status: unknown): string[] {
  if (Array.isArray(status)) return fromStatusList(status);
  if (!isRecord(status)) return [];
  const statusFields = status;
  if (Array.isArray(statusFields.data)) return fromStatusList(statusFields.data);

  const capabilityIDs: string[] = [];
  for (const [clientName, clientStatus] of Object.entries(statusFields)) {
    if (isRecord(clientStatus) && clientStatus.status === 'connected') {
      const sanitized = sanitizeMcpClientName(clientName);
      if (sanitized) {
        capabilityIDs.push(`mcp_${sanitized}`);
      }
    }
  }
  return capabilityIDs;
}
