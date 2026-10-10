export const rules = [
  ['private-key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['service-token', /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{20,})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g],
  ['url-credential', /(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis|https?):\/\/[^\s/'"<>:]+:[^\s/'"<>@]+@/g],
  ['literal-credential', /[\"']?\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret[_-]?key|origin)[\"']?\s*[:=]\s*(['"])([^'"\r\n]{8,})\1/gi],
];
