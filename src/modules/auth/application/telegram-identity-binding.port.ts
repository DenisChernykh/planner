import type { VerifiedTelegramOidcIdentity } from './telegram-oidc.ports'

export interface TelegramIdentityBindingPort {
  bindVerifiedIdentity(identity: VerifiedTelegramOidcIdentity): Promise<string>
}

export const TELEGRAM_IDENTITY_BINDING_PORT: unique symbol = Symbol(
  'TELEGRAM_IDENTITY_BINDING_PORT',
)
