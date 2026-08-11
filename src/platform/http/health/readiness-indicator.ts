export interface ReadinessIndicator {
  readonly timeoutMs?: number
  check(signal: AbortSignal): Promise<'up' | 'down'>
}
