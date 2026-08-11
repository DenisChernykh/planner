import {
  Injectable,
  UnsupportedMediaTypeException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'

import { AuthCsrfRejectedError } from '../application/auth-errors'

interface BrowserRequest {
  readonly method: string
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

function oneHeader(
  headers: BrowserRequest['headers'],
  name: string,
): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function refererOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>

  public constructor(allowedOrigins: readonly string[]) {
    this.allowedOrigins = new Set(allowedOrigins)
  }

  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<BrowserRequest>()
    if (safeMethods.has(request.method.toUpperCase())) return true
    const contentType = oneHeader(request.headers, 'content-type')
    if (
      contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    ) {
      throw new UnsupportedMediaTypeException()
    }
    const rawOrigin = request.headers['origin']
    const rawReferer = request.headers['referer']
    const fetchSite = request.headers['sec-fetch-site']
    if (
      Array.isArray(rawOrigin) ||
      Array.isArray(rawReferer) ||
      Array.isArray(fetchSite)
    ) {
      throw new AuthCsrfRejectedError()
    }
    const origin =
      (typeof rawOrigin === 'string' ? rawOrigin : undefined) ??
      refererOrigin(typeof rawReferer === 'string' ? rawReferer : undefined)
    if (
      fetchSite === 'cross-site' ||
      origin === undefined ||
      !this.allowedOrigins.has(origin)
    )
      throw new AuthCsrfRejectedError()
    return true
  }
}
