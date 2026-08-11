import { Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core'

import { AuthenticateSessionUseCase } from '../application/authenticate-session.use-case'
import { GetCsrfTokenQuery } from '../application/get-csrf-token.query'
import { IssueSessionUseCase } from '../application/issue-session.use-case'
import { LOCAL_USER_PORT } from '../application/local-user.port'
import { RevokeSessionUseCase } from '../application/revoke-session.use-case'
import { SESSION_STORE } from '../application/session-store.port'
import { NodeAuthCryptoAdapter } from '../infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '../infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '../infrastructure/redis-session.store'
import { AuthCookieAdapter } from '../presentation/auth-cookie.adapter'
import { AuthRequestContext } from '../presentation/auth-request.context'
import { AuthRequestInterceptor } from '../presentation/auth-request.interceptor'
import { AuthController } from '../presentation/auth.controller'
import { AuthenticationGuard } from '../presentation/authentication.guard'
import { BrowserOriginGuard } from '../presentation/browser-origin.guard'
import { SessionCsrfGuard } from '../presentation/session-csrf.guard'
import { RuntimeConfigService } from '@/platform/config/runtime-config.service'
import { DatabaseModule } from '@/platform/database/database.module'
import { RedisModule } from '@/platform/redis/redis.module'
import { REDIS_AUTH_COMMAND_EXECUTOR } from '@/platform/redis/redis.tokens'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [
    PrismaLocalUserRepository,
    { provide: LOCAL_USER_PORT, useExisting: PrismaLocalUserRepository },
    NodeAuthCryptoAdapter,
    {
      provide: RedisSessionStore,
      inject: [
        REDIS_AUTH_COMMAND_EXECUTOR,
        NodeAuthCryptoAdapter,
        RuntimeConfigService,
      ],
      useFactory: (
        executor: RedisCommandExecutorPort,
        crypto: NodeAuthCryptoAdapter,
        config: RuntimeConfigService,
      ) =>
        new RedisSessionStore(executor, crypto, {
          keyPrefix: config.redis.keyPrefix,
          sessionKeySecret: config.auth.sessionKeySecret,
          csrfSecret: config.auth.csrfSecret,
          idleTimeoutMs: config.auth.idleTimeoutMs,
          absoluteTimeoutMs: config.auth.absoluteTimeoutMs,
          touchIntervalMs: config.auth.touchIntervalMs,
        }),
    },
    { provide: SESSION_STORE, useExisting: RedisSessionStore },
    AuthenticateSessionUseCase,
    GetCsrfTokenQuery,
    IssueSessionUseCase,
    RevokeSessionUseCase,
    AuthRequestContext,
    {
      provide: AuthCookieAdapter,
      inject: [RuntimeConfigService],
      useFactory: (config: RuntimeConfigService) =>
        new AuthCookieAdapter(
          config.auth.sessionCookieName,
          config.auth.secureCookie,
        ),
    },
    {
      provide: AuthenticationGuard,
      inject: [
        Reflector,
        AuthenticateSessionUseCase,
        AuthRequestContext,
        RuntimeConfigService,
      ],
      useFactory: (
        reflector: Reflector,
        authenticate: AuthenticateSessionUseCase,
        requestContext: AuthRequestContext,
        config: RuntimeConfigService,
      ) =>
        new AuthenticationGuard(
          reflector,
          authenticate,
          requestContext,
          config.auth.sessionCookieName,
        ),
    },
    {
      provide: BrowserOriginGuard,
      inject: [RuntimeConfigService],
      useFactory: (config: RuntimeConfigService) =>
        new BrowserOriginGuard(config.auth.csrfOrigins),
    },
    {
      provide: SessionCsrfGuard,
      inject: [Reflector, AuthRequestContext, GetCsrfTokenQuery],
      useFactory: (
        reflector: Reflector,
        requestContext: AuthRequestContext,
        csrf: GetCsrfTokenQuery,
      ) => new SessionCsrfGuard(reflector, requestContext, csrf),
    },
    AuthRequestInterceptor,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    { provide: APP_GUARD, useExisting: BrowserOriginGuard },
    { provide: APP_GUARD, useExisting: SessionCsrfGuard },
    { provide: APP_INTERCEPTOR, useExisting: AuthRequestInterceptor },
  ],
  exports: [IssueSessionUseCase],
})
export class AuthModule {}
