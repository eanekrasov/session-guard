import { describe, expect, test } from 'vitest';
import type { ConsentManifest, ConsentRequest } from '../../src/app/consent.ts';
import {
  calculatePlanEvidence,
  canonicalManifest,
  classifyConsentAnswer,
  CONSENT_EVIDENCE_SCHEMA,
  CONSENT_REQUEST_SCHEMA,
  evidenceOf,
  parseConsentRequest,
} from '../../src/app/consent.ts';

const MANIFEST_V1: ConsentManifest = {
  schema: CONSENT_EVIDENCE_SCHEMA,
  revision: 3,
  summary: 'Implement feature X',
  files: ['app/A.kt', 'app/B.kt'],
};

const EVIDENCE_V1 = evidenceOf(MANIFEST_V1);

function makeTag(
  manifest: ConsentManifest,
  overrides: Partial<Record<'revision' | 'evidence' | 'grant' | 'decline' | 'schema', string>> = {}
): string {
  const evidence = overrides.evidence ?? evidenceOf(manifest);
  const revision = overrides.revision ?? String(manifest.revision);
  const grant = overrides.grant ?? 'grant';
  const decline = overrides.decline ?? 'decline';
  const schema = overrides.schema ?? CONSENT_REQUEST_SCHEMA;
  return `<consent-request schema="${schema}" revision="${revision}" evidence="${evidence}" grant="${grant}" decline="${decline}">${JSON.stringify(manifest)}</consent-request>`;
}

describe('parseConsentRequest', () => {
  test('parses valid tag', () => {
    const tag = makeTag(MANIFEST_V1);
    const result = parseConsentRequest(tag);
    expect(result).not.toBeUndefined();
    expect(result!.schema).toBe(CONSENT_REQUEST_SCHEMA);
    expect(result!.revision).toBe(3);
    expect(result!.evidence).toBe(EVIDENCE_V1);
    expect(result!.grant).toBe('grant');
    expect(result!.decline).toBe('decline');
    expect(result!.manifest).toEqual(MANIFEST_V1);
  });

  test('returns undefined for no tag', () => {
    expect(parseConsentRequest('Просто вопрос без тега')).toBeUndefined();
  });

  test('returns undefined for tag without closing', () => {
    expect(
      parseConsentRequest(
        '<consent-request schema="harness.consent/v1" revision="1" evidence="sha256:abc" grant="grant" decline="decline">'
      )
    ).toBeUndefined();
  });

  test('returns undefined for broken JSON body', () => {
    const tag = `<consent-request schema="${CONSENT_REQUEST_SCHEMA}" revision="3" evidence="${EVIDENCE_V1}" grant="grant" decline="decline">{oops}</consent-request>`;
    expect(parseConsentRequest(tag)).toBeUndefined();
  });

  test('returns undefined for missing evidence attribute', () => {
    const tag = `<consent-request schema="${CONSENT_REQUEST_SCHEMA}" revision="3" grant="grant" decline="decline">${JSON.stringify(MANIFEST_V1)}</consent-request>`;
    expect(parseConsentRequest(tag)).toBeUndefined();
  });

  test('returns undefined for wrong schema', () => {
    const tag = makeTag(MANIFEST_V1, { schema: 'harness.consent/v0' });
    expect(parseConsentRequest(tag)).toBeUndefined();
  });

  test('returns undefined for invalid evidence format', () => {
    const tag = makeTag(MANIFEST_V1, { evidence: 'abc' });
    expect(parseConsentRequest(tag)).toBeUndefined();
  });

  test('rejects manifest.revision !== tag.revision', () => {
    const tag = makeTag(MANIFEST_V1, { revision: '5' });
    expect(parseConsentRequest(tag)).toBeUndefined();
  });

  test('rejects files with ../', () => {
    const badManifest: ConsentManifest = { ...MANIFEST_V1, files: ['../etc/passwd'] };
    expect(parseConsentRequest(makeTag(badManifest))).toBeUndefined();
  });

  test('rejects absolute paths', () => {
    const badManifest: ConsentManifest = { ...MANIFEST_V1, files: ['/etc/passwd'] };
    expect(parseConsentRequest(makeTag(badManifest))).toBeUndefined();
  });

  test('rejects empty summary', () => {
    const badManifest: ConsentManifest = { ...MANIFEST_V1, summary: '   ' };
    expect(parseConsentRequest(makeTag(badManifest))).toBeUndefined();
  });

  test('rejects summary > 400 chars', () => {
    const badManifest: ConsentManifest = { ...MANIFEST_V1, summary: 'x'.repeat(401) };
    expect(parseConsentRequest(makeTag(badManifest))).toBeUndefined();
  });

  test('handles custom grant/decline tokens', () => {
    const tag = makeTag(MANIFEST_V1, { grant: 'yes', decline: 'no' });
    const result = parseConsentRequest(tag);
    expect(result!.grant).toBe('yes');
    expect(result!.decline).toBe('no');
  });
});

describe('canonicalManifest', () => {
  test('sorts keys lexicographically', () => {
    const manifest: ConsentManifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Test',
      files: ['z.kt', 'a.kt', 'm.kt'],
    };
    const canonical = canonicalManifest(manifest);
    // `type` входит в подпись даже когда манифест его не назвал: иначе
    // «согласие на деплой» и «согласие на план» с теми же файлами дают одну и
    // ту же evidence. Отсутствующий тип нормализуется в `plan` — манифест,
    // написанный до появления поля, подписывается ровно как раньше значил.
    expect(canonical).toBe(
      '{"files":["a.kt","m.kt","z.kt"],"revision":1,"schema":"harness.consent.evidence/v1","summary":"Test","type":"plan"}'
    );
  });

  test('манифесты с разными типами подписываются по-разному', () => {
    const base: ConsentManifest = {
      schema: CONSENT_EVIDENCE_SCHEMA,
      revision: 1,
      summary: 'Test',
      files: ['a.kt'],
    };
    expect(canonicalManifest({ ...base, type: 'deploy' })).not.toBe(canonicalManifest(base));
  });

  test('is stable for same input', () => {
    expect(canonicalManifest(MANIFEST_V1)).toBe(canonicalManifest(MANIFEST_V1));
  });
});

describe('evidenceOf', () => {
  test('returns sha256:hex format', () => {
    const evidence = evidenceOf(MANIFEST_V1);
    expect(evidence).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('is stable on same input', () => {
    expect(evidenceOf(MANIFEST_V1)).toBe(evidenceOf(MANIFEST_V1));
  });

  test('different manifests produce different evidence', () => {
    const m2: ConsentManifest = { ...MANIFEST_V1, summary: 'Different' };
    expect(evidenceOf(MANIFEST_V1)).not.toBe(evidenceOf(m2));
  });
});

describe('calculatePlanEvidence', () => {
  test('returns sha256:hex of canonicalized content', () => {
    expect(calculatePlanEvidence('Plan v1\r\nline two  \r\n')).toBe(
      'sha256:7051502404136f79f7167a7d99c7f69c8f06d1175006e962de2da175d8596f5d'
    );
  });

  test('ignores CRLF and trailing-whitespace differences', () => {
    expect(calculatePlanEvidence('a \r\nb\t\r\n')).toBe(calculatePlanEvidence('a\nb\n'));
  });
});

describe('classifyConsentAnswer', () => {
  const request: ConsentRequest = {
    schema: CONSENT_REQUEST_SCHEMA,
    revision: 3,
    evidence: EVIDENCE_V1,
    grant: 'grant',
    decline: 'decline',
    manifest: MANIFEST_V1,
  };

  test('classifies grant', () => {
    expect(classifyConsentAnswer(['grant'], request)).toEqual({ kind: 'grant' });
  });

  test('classifies decline', () => {
    expect(classifyConsentAnswer(['decline'], request)).toEqual({ kind: 'decline' });
  });

  test('classifies custom tokens', () => {
    const custom: ConsentRequest = { ...request, grant: 'yes', decline: 'no' };
    expect(classifyConsentAnswer(['yes'], custom)).toEqual({ kind: 'grant' });
    expect(classifyConsentAnswer(['no'], custom)).toEqual({ kind: 'decline' });
  });

  test('checks decline before a grant prefix', () => {
    const overlapping: ConsentRequest = {
      ...request,
      grant: 'Approve',
      decline: 'Approve after changes',
    };
    expect(classifyConsentAnswer(['Approve after changes'], overlapping)).toEqual({
      kind: 'decline',
    });
  });

  test('multi-select is unrecognized', () => {
    expect(classifyConsentAnswer(['grant', 'decline'], request)).toEqual({
      kind: 'unrecognized',
      raw: ['grant', 'decline'],
    });
  });

  test('arbitrary text is unrecognized', () => {
    expect(classifyConsentAnswer(['да'], request)).toEqual({
      kind: 'unrecognized',
      raw: ['да'],
    });
  });

  test('empty is unrecognized', () => {
    expect(classifyConsentAnswer([], request)).toEqual({
      kind: 'unrecognized',
      raw: [],
    });
  });

  test('Unanswered is unrecognized', () => {
    expect(classifyConsentAnswer(['Unanswered'], request)).toEqual({
      kind: 'unrecognized',
      raw: ['Unanswered'],
    });
  });
});
