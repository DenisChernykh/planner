import { timingSafeEqual } from 'node:crypto'

import type { Response } from 'express'

const cookieStatePattern = /^[A-Za-z0-9_-]{43}$/u

function decodeState(value: string): Buffer | undefined {
  if (!cookieStatePattern.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === 32 && decoded.toString('base64url') === value
    ? decoded
    : undefined
}

export class OidcStateCookieAdapter {
  private readonly cookieName: string

  public constructor(
    private readonly secure: boolean,
    private readonly maxAgeMs: number = 300_000,
  ) {
    if (maxAgeMs !== 300_000) {
      throw new Error('OIDC state cookie lifetime rejected')
    }
    this.cookieName = secure
      ? '__Host-planner-oidc-state'
      : 'planner-oidc-state'
  }

  public set(response: Response, state: string): void {
    response.cookie(this.cookieName, state, {
      httpOnly: true,
      maxAge: this.maxAgeMs,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    })
  }

  public read(cookieHeader: string | undefined): string | undefined {
    if (cookieHeader === undefined) return undefined
    const values = cookieHeader
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith(`${this.cookieName}=`))
      .map((entry) => entry.slice(this.cookieName.length + 1))
    if (values.length !== 1) return undefined
    const value = values[0]
    return value !== undefined && decodeState(value) !== undefined
      ? value
      : undefined
  }

  public matches(cookieHeader: string | undefined, state: string): boolean {
    const cookie = this.read(cookieHeader)
    const cookieBytes = cookie === undefined ? undefined : decodeState(cookie)
    const stateBytes = decodeState(state)
    const fallback = Buffer.alloc(32)
    const equal = timingSafeEqual(
      cookieBytes ?? fallback,
      stateBytes ?? fallback,
    )
    return cookieBytes !== undefined && stateBytes !== undefined && equal
  }

  public clear(response: Response): void {
    response.clearCookie(this.cookieName, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    })
  }
}
