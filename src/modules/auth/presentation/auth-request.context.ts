import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable } from '@nestjs/common'

import { AuthenticationRequiredError } from '../application/auth-errors'
import type { AuthenticatedPrincipal } from '../application/auth.types'

interface AuthRequestState {
  readonly principal: AuthenticatedPrincipal
  readonly rawToken: string
}

@Injectable()
export class AuthRequestContext {
  private readonly storage = new AsyncLocalStorage<AuthRequestState>()
  private readonly prepared = new WeakMap<object, AuthRequestState>()

  public get principal(): AuthenticatedPrincipal {
    const state = this.storage.getStore()
    if (state === undefined) throw new AuthenticationRequiredError()
    return state.principal
  }

  public get rawToken(): string {
    const state = this.storage.getStore()
    if (state === undefined) throw new AuthenticationRequiredError()
    return state.rawToken
  }

  public prepare(
    request: object,
    principal: AuthenticatedPrincipal,
    rawToken: string,
  ): void {
    this.prepared.set(request, Object.freeze({ principal, rawToken }))
  }

  public preparedState(request: object): AuthRequestState {
    const state = this.prepared.get(request)
    if (state === undefined) throw new AuthenticationRequiredError()
    return state
  }

  public run<T>(request: object, operation: () => T): T {
    const state = this.prepared.get(request)
    if (state === undefined) throw new AuthenticationRequiredError()
    this.prepared.delete(request)
    return this.storage.run(state, operation)
  }
}
