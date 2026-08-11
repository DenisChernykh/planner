export interface ReadinessIndicator {
  check(signal: AbortSignal): Promise<'up' | 'down'>
}
