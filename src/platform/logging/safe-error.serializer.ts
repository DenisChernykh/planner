const labelledSecret =
  /\b(authorization|password|token|secret|api[-_]?key|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu
const bearerCredential = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu
const sensitiveUrl = /\b(?:https?|postgres(?:ql)?|redis(?:s)?):\/\/[^\s]+/giu

export interface SafeSerializedError {
  readonly type: string
  readonly stack?: readonly string[]
}

export function sanitizeLogText(value: string): string {
  return value
    .replace(labelledSecret, '$1=[redacted]')
    .replace(bearerCredential, 'Bearer [redacted]')
    .replace(sensitiveUrl, '[redacted-url]')
    .slice(0, 512)
}

export function serializeSafeError(error: unknown): SafeSerializedError {
  if (!(error instanceof Error)) return { type: 'NonError' }
  const type = /^[A-Za-z][A-Za-z0-9]{0,127}$/u.test(error.constructor.name)
    ? error.constructor.name
    : 'Error'
  return { type }
}
