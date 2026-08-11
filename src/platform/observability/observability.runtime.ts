export interface ObservabilitySdk {
  shutdown(): Promise<void>
}

export class ObservabilityRuntime {
  private closePromise: Promise<void> | undefined

  public constructor(private readonly sdk?: ObservabilitySdk) {}

  public async close(signal: AbortSignal): Promise<void> {
    if (this.sdk === undefined) return
    this.closePromise ??= this.sdk.shutdown()
    if (signal.aborted) throw new Error('OpenTelemetry shutdown deadline')
    await Promise.race([
      this.closePromise,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('OpenTelemetry shutdown deadline')),
          { once: true },
        ),
      ),
    ])
  }
}
