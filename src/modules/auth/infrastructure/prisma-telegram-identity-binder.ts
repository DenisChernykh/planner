import { Inject, Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'

import {
  AuthDependencyUnavailableError,
  OidcAccessDeniedError,
} from '../application/auth-errors'
import type { TelegramIdentityBindingPort } from '../application/telegram-identity-binding.port'
import {
  TELEGRAM_OIDC_ISSUER,
  type VerifiedTelegramOidcIdentity,
} from '../application/telegram-oidc.ports'

const TELEGRAM_IDENTITY_BINDING_ADVISORY_LOCK = 8_503_113_702n
const MAX_PROVIDER_USER_ID = 2n ** 52n - 1n

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isConstraintRace(error: unknown): boolean {
  if (!isRecord(error)) return false
  return (
    error['code'] === 'P2002' ||
    error['code'] === 'P2003' ||
    error['code'] === '23505' ||
    error['code'] === '23503'
  )
}

function isValidIdentity(identity: VerifiedTelegramOidcIdentity): boolean {
  const subjectBytes = Buffer.byteLength(identity.subject, 'utf8')
  return (
    identity.issuer === TELEGRAM_OIDC_ISSUER &&
    subjectBytes >= 1 &&
    subjectBytes <= 255 &&
    Buffer.from(identity.subject, 'utf8').toString('utf8') ===
      identity.subject &&
    !containsControlCharacter(identity.subject) &&
    identity.providerUserId >= 1n &&
    identity.providerUserId <= MAX_PROVIDER_USER_ID
  )
}

@Injectable()
export class PrismaTelegramIdentityBinder implements TelegramIdentityBindingPort {
  public constructor(
    @Inject(DATABASE_TRANSACTION_PORT)
    private readonly transaction: DatabaseTransactionPort,
    private readonly database: PrismaClientProvider,
  ) {}

  public async bindVerifiedIdentity(
    identity: VerifiedTelegramOidcIdentity,
  ): Promise<string> {
    if (!isValidIdentity(identity)) throw new OidcAccessDeniedError()
    try {
      return await this.transaction.run(() =>
        this.bindInsideTransaction(identity),
      )
    } catch (error: unknown) {
      if (error instanceof OidcAccessDeniedError) throw error
      if (isConstraintRace(error)) {
        throw new OidcAccessDeniedError({ cause: error })
      }
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  private async bindInsideTransaction(
    identity: VerifiedTelegramOidcIdentity,
  ): Promise<string> {
    return this.database.withClient(async (client) => {
      await client.$executeRaw`SELECT pg_advisory_xact_lock(${TELEGRAM_IDENTITY_BINDING_ADVISORY_LOCK})`
      const allowlist = await client.telegramAccessAllowlist.findUnique({
        where: { telegramId: identity.providerUserId },
        select: { userId: true, telegramId: true },
      })
      if (allowlist === null) throw new OidcAccessDeniedError()

      const existing = await client.telegramExternalIdentity.findMany({
        where: {
          issuer: identity.issuer,
          OR: [
            { subject: identity.subject },
            { providerUserId: identity.providerUserId },
            { userId: allowlist.userId },
          ],
        },
        select: {
          issuer: true,
          subject: true,
          providerUserId: true,
          userId: true,
        },
      })

      if (existing.length === 0) {
        const created = await client.telegramExternalIdentity.create({
          data: {
            issuer: identity.issuer,
            subject: identity.subject,
            providerUserId: identity.providerUserId,
            userId: allowlist.userId,
          },
          select: { userId: true },
        })
        return created.userId
      }

      const exact = existing[0]
      if (
        existing.length === 1 &&
        exact !== undefined &&
        exact.issuer === identity.issuer &&
        exact.subject === identity.subject &&
        exact.providerUserId === identity.providerUserId &&
        exact.userId === allowlist.userId &&
        allowlist.telegramId === identity.providerUserId
      ) {
        return exact.userId
      }
      throw new OidcAccessDeniedError()
    })
  }
}
