import type { AddressInfo } from 'node:net'

import type { ApiRuntimeResources } from './configure-api'

async function createConfiguredApi(): Promise<ApiRuntimeResources> {
  const { configureApi } = await import('./configure-api.js')
  return configureApi()
}

export type ApiRuntimeFactory = () => Promise<ApiRuntimeResources>

export class ApiRuntime {
  private startPromise: Promise<AddressInfo | string | null> | undefined
  private startupController: AbortController | undefined
  private resources: ApiRuntimeResources | undefined
  private cleanupPromise: Promise<void> | undefined
  private cancelled = false

  public constructor(
    private readonly factory: ApiRuntimeFactory = createConfiguredApi,
  ) {}

  public start(): Promise<AddressInfo | string | null> {
    this.startPromise ??= this.startInternal()
    return this.startPromise
  }

  public cancelStartup(): void {
    this.cancelled = true
    this.resources?.lifecycle.beginDrain()
    this.startupController?.abort()
  }

  public get currentResources(): ApiRuntimeResources | undefined {
    return this.resources
  }

  public async stop(): Promise<void> {
    this.cancelStartup()
    await this.startPromise?.catch(() => undefined)
    await this.cleanupPartialResources()
  }

  private async startInternal(): Promise<AddressInfo | string | null> {
    this.startupController = new AbortController()
    try {
      this.ensureStartupAllowed()
      this.resources = await this.factory()
      this.ensureStartupAllowed()
      await this.resources.application.listen()
      this.ensureStartupAllowed()
      await this.startDependencies(
        this.resources,
        this.startupController.signal,
      )
      this.ensureStartupAllowed()
      this.resources.lifecycle.markReady()
      return this.resources.application.address()
    } catch (error: unknown) {
      this.resources?.lifecycle.beginDrain()
      await this.cleanupPartialResources()
      throw new Error('API startup failed', { cause: error })
    }
  }

  private async startDependencies(
    resources: ApiRuntimeResources,
    signal: AbortSignal,
  ): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => resources.database.connect(signal)),
      Promise.resolve().then(() => resources.redis.connect(signal)),
    ])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure === undefined) return
    throw failure.reason
  }

  private ensureStartupAllowed(): void {
    if (
      this.cancelled ||
      this.startupController?.signal.aborted === true ||
      this.resources?.lifecycle.phase === 'draining'
    ) {
      throw new Error('API startup cancelled')
    }
  }

  private async cleanupPartialResources(): Promise<void> {
    const resources = this.resources
    if (resources === undefined) return
    this.cleanupPromise ??= (async () => {
      const signal = AbortSignal.timeout(resources.shutdownGraceMs)
      await Promise.allSettled([
        resources.database.close(signal),
        resources.redis.close(signal),
      ])
      await resources.application.close().catch(() => undefined)
    })()
    await this.cleanupPromise
  }
}
