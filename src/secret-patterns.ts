/**
 * High-confidence secret-shape patterns, shared by the diff safety scanner
 * (src/safety-scanner.ts) and the log-tail redactor (src/logger.ts) so secret
 * detection stays consistent across both surfaces.
 *
 * This module deliberately has NO other imports: logger.ts redacts on every log
 * line, and pulling in the safety scanner (→ ai/parse → logger) would create an
 * import cycle. Keeping the patterns in a leaf module avoids that and gives both
 * call sites a single source of truth.
 *
 * Keep this list tight — false positives are a trust killer in review comments
 * and would over-redact otherwise-useful logs.
 */
export interface SecretPattern {
  id: string;
  label: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: "aws-access-key-id", label: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "aws-secret-access-key", label: "AWS Secret Access Key", regex: /aws_?secret(_access)?_?key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/i },
  { id: "github-token", label: "GitHub Token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  // Anthropic is listed before the broader OpenAI `sk-` pattern so a redactor
  // applying patterns in order labels an `sk-ant-…` key correctly (the safety
  // scanner tests every pattern independently, so order doesn't affect it).
  { id: "anthropic-key", label: "Anthropic API Key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", label: "OpenAI API Key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", label: "Slack Token", regex: /\bxox[pbar]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-key", label: "Stripe Secret Key", regex: /\b(sk|rk)_(test|live)_[A-Za-z0-9]{20,}\b/ },
  { id: "google-api-key", label: "Google API Key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "private-key-pem", label: "PEM Private Key", regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "jwt", label: "JWT", regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { id: "generic-bearer", label: "Bearer Token", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
];
