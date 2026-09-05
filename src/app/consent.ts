import { canonicalizePlan, computeSha256 } from './sdd-artifacts.ts';

export const CONSENT_REQUEST_SCHEMA = 'harness.consent/v1';
export const CONSENT_EVIDENCE_SCHEMA = 'harness.consent.evidence/v1';

export const CONSENT_TAG_REGEX = /<consent-request\s+([^>]*)>([\s\S]*?)<\/consent-request>/iu;

export interface ConsentManifest {
  schema: typeof CONSENT_EVIDENCE_SCHEMA;
  revision: number;
  summary: string;
  files: string[];
}

export interface ConsentRequest {
  schema: typeof CONSENT_REQUEST_SCHEMA;
  revision: number;
  evidence: string;
  grant: string;
  decline: string;
  manifest: ConsentManifest;
}

export type ConsentAnswer =
  { kind: 'grant' } | { kind: 'decline' } | { kind: 'unrecognized'; raw: string[] };

export function parseConsentRequest(questionText: string): ConsentRequest | undefined {
  const match = CONSENT_TAG_REGEX.exec(questionText);
  if (!match) return undefined;

  const attributesStr = match[1]!;
  const bodyStr = match[2]!.trim();

  const attributes: Record<string, string> = {};
  for (const attr of attributesStr.matchAll(/([\p{L}_][\p{L}0-9_:-]*)\s*=\s*"([^"]*)"/gu)) {
    attributes[attr[1]!] = attr[2]!;
  }

  if (
    !attributes.schema ||
    attributes.schema !== CONSENT_REQUEST_SCHEMA ||
    !attributes.revision ||
    !attributes.evidence ||
    !attributes.grant ||
    !attributes.decline
  ) {
    return undefined;
  }

  const revision = parseInt(attributes.revision, 10);
  if (Number.isNaN(revision) || revision < 0) return undefined;

  if (!/^sha256:[0-9a-f]{64}$/iu.test(attributes.evidence)) return undefined;

  let manifest: ConsentManifest;
  try {
    manifest = JSON.parse(bodyStr) as ConsentManifest;
  } catch {
    return undefined;
  }

  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    manifest.schema !== CONSENT_EVIDENCE_SCHEMA ||
    typeof manifest.revision !== 'number' ||
    manifest.revision !== revision ||
    typeof manifest.summary !== 'string' ||
    !manifest.summary.trim() ||
    manifest.summary.length > 400 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some(
      (f) => typeof f !== 'string' || !f.trim() || f.includes('..') || f.startsWith('/')
    )
  ) {
    return undefined;
  }

  return {
    schema: attributes.schema as typeof CONSENT_REQUEST_SCHEMA,
    revision,
    evidence: attributes.evidence,
    grant: attributes.grant,
    decline: attributes.decline,
    manifest,
  };
}

export function canonicalManifest(manifest: ConsentManifest): string {
  const sorted = {
    files: [...manifest.files].sort(),
    revision: manifest.revision,
    schema: manifest.schema,
    summary: manifest.summary,
  };
  return JSON.stringify(sorted);
}

export function evidenceOf(manifest: ConsentManifest): string {
  return computeSha256(canonicalManifest(manifest));
}

/** Consent trust root: real SHA-256 over canonicalized plan file content. */
export function calculatePlanEvidence(planContent: string): string {
  return computeSha256(canonicalizePlan(planContent));
}

export function classifyConsentAnswer(answer: string[], request: ConsentRequest): ConsentAnswer {
  const normalized = answer.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean);

  if (normalized.length === 0) {
    return { kind: 'unrecognized', raw: answer };
  }

  if (normalized.length > 1) {
    return { kind: 'unrecognized', raw: answer };
  }

  const single = normalized[0]!;
  if (single.startsWith(request.grant)) {
    return { kind: 'grant' };
  }
  if (single.startsWith(request.decline)) {
    return { kind: 'decline' };
  }
  return { kind: 'unrecognized', raw: answer };
}
