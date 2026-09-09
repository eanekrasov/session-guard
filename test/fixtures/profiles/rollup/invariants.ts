export const INVARIANTS = [
  {
    id: 'LF_ONLY',
    severity: 'error',
    check: (content: string) =>
      /\r/u.test(content) ? 'CRLF detected — use LF line endings.' : null,
  },
];
