import { parseDiagnosticContext } from './contact';

const SECRET_PATTERNS: RegExp[] = [
  /["'](?:password|passwd|passphrase|パスワード|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|token|cookie|set-cookie|authorization)["']\s*[:：=]\s*"(?:\\.|[^"\\])*"/gi,
  /["'](?:password|passwd|passphrase|パスワード|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|token|cookie|set-cookie|authorization)["']\s*[:：=]\s*'(?:\\.|[^'\\])*'/gi,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /[\"']?(?:password|passwd|passphrase|パスワード|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|token)[\"']?\s*[:：=]\s*[\"']?[^\s,;\"'}]+[\"']?/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?:Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)(?:\+?\d[\d ()-]{7,}\d)(?!\w)/g;

function replaceAll(patterns: RegExp[], value: string): string {
  return patterns.reduce((text, pattern) => text.replace(pattern, '[秘密情報を削除]'), value);
}

/** Removes secret-bearing fields before any copy of a message can be persisted. */
export function removeFeedbackSecrets(value: string): string {
  return replaceAll(SECRET_PATTERNS, value).slice(0, 12_000);
}

/** Redacts common direct identifiers from the operator-visible and provider-visible text. */
export function sanitizeFeedbackMessage(value: string): string {
  return removeFeedbackSecrets(value)
    .replace(EMAIL, '[メールアドレス]')
    .replace(PHONE, '[電話番号]')
    .slice(0, 12_000);
}

/** Diagnostics arrive as a strict whitelist from contact.ts; stringify/reparse for a detached JSON value. */
export function sanitizeFeedbackDiagnostics(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const validated = parseDiagnosticContext(value);
  if (!validated) return null;
  try {
    const encoded = JSON.stringify(validated);
    if (encoded.length > 8_000) return null;
    return encoded;
  } catch {
    return null;
  }
}
