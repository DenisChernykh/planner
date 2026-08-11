import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable } from '@nestjs/common'

@Injectable()
export class RequestContext {
  readonly #storage = new AsyncLocalStorage<Readonly<{ requestId: string }>>()

  public run<T>(requestId: string, callback: () => T): T {
    return this.#storage.run(Object.freeze({ requestId }), callback)
  }

  public getRequestId(): string | undefined {
    return this.#storage.getStore()?.requestId
  }

  public getProblemInstance(): string | undefined {
    const requestId = this.getRequestId()
    return requestId === undefined ? undefined : `urn:request:${requestId}`
  }
}
