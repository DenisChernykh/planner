import { timingSafeEqual } from 'node:crypto'

import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { AuthCsrfRejectedError } from '../application/auth-errors'
import type { GetCsrfTokenQuery } from '../application/get-csrf-token.query'

import type { AuthRequestContext } from './auth-request.context'

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

function tokenBytes(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === value
    ? bytes
    : undefined
}

export function constantTimeCsrfTokenEqual(
  provided: string,
  expected: string,
): boolean {
  const providedBytes = tokenBytes(provided)
  const expectedBytes = tokenBytes(expected)
  const fallback = Buffer.alloc(32)
  const equal = timingSafeEqual(
    providedBytes ?? fallback,
    expectedBytes ?? fallback,
  )
  return providedBytes !== undefined && expectedBytes !== undefined && equal
}

interface CsrfRequest {
  readonly method: string
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >
}

@Injectable()
export class SessionCsrfGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: AuthRequestContext,
    private readonly csrf: GetCsrfTokenQuery,
    private readonly compare: (
      provided: string,
      expected: string,
    ) => boolean = constantTimeCsrfTokenEqual,
    private readonly now: () => number = Date.now,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    void this.reflector
    const request = context.switchToHttp().getRequest<CsrfRequest>()
    if (safeMethods.has(request.method.toUpperCase())) return true
    const provided = request.headers['x-csrf-token']
    if (typeof provided !== 'string') throw new AuthCsrfRejectedError()
    const { rawToken } = this.requestContext.preparedState(request)
    const { csrfToken } = await this.csrf.execute(rawToken, this.now())
    if (!this.compare(provided, csrfToken)) {
      throw new AuthCsrfRejectedError()
    }
    return true
  }
}
