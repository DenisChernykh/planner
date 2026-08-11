import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { defer, type Observable } from 'rxjs'

import { PUBLIC_ENDPOINT_METADATA } from '@/platform/http/policy/public-endpoint.decorator'

import { AuthRequestContext } from './auth-request.context'

@Injectable()
export class AuthRequestInterceptor implements NestInterceptor {
  public constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: AuthRequestContext,
  ) {}

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ENDPOINT_METADATA,
      [context.getHandler(), context.getClass()],
    )
    if (isPublic === true) return next.handle()
    const request = context.switchToHttp().getRequest<object>()
    return defer(() => this.requestContext.run(request, () => next.handle()))
  }
}
