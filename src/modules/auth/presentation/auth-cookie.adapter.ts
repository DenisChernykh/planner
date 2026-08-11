import { Injectable } from '@nestjs/common'
import type { Response } from 'express'

import type { IssuedBrowserSession } from '../application/session-store.port'

@Injectable()
export class AuthCookieAdapter {
  public constructor(
    private readonly cookieName: string,
    private readonly secure: boolean,
  ) {}

  public set(response: Response, session: IssuedBrowserSession): void {
    response.cookie(this.cookieName, session.rawToken, {
      expires: session.absoluteExpiresAt,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    })
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
