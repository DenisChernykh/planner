import { TelegramOutboundTransport } from '../infrastructure/telegram-outbound.transport'

export function createTelegramOutboundTransport(
  token: string,
  config: {
    readonly requestTimeoutMs: number
    readonly responseBodyLimitBytes: number
  },
): TelegramOutboundTransport {
  return new TelegramOutboundTransport(token, config)
}
