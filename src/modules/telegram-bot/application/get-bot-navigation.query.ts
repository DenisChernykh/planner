export const BOT_NAVIGATION_SCHEMA_VERSION = 'telegram.navigation.v1' as const

export type BotNavigationStatus = 'available' | 'disabled' | 'misconfigured'

export type BotNavigationResult = Readonly<
  | {
      schemaVersion: typeof BOT_NAVIGATION_SCHEMA_VERSION
      capability: 'open_bot'
      status: 'available'
      url: string
    }
  | {
      schemaVersion: typeof BOT_NAVIGATION_SCHEMA_VERSION
      capability: 'open_bot'
      status: 'disabled' | 'misconfigured'
      url: null
    }
>

function safeTelegramBotUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.toString() !== value ||
      url.protocol !== 'https:' ||
      url.hostname !== 't.me' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !/^\/[A-Za-z0-9_]{5,32}$/u.test(url.pathname)
    ) {
      return undefined
    }
    return value
  } catch {
    return undefined
  }
}

export class GetBotNavigationQuery {
  public constructor(private readonly configuredUrl?: string) {}

  public execute(): BotNavigationResult {
    if (this.configuredUrl === undefined) {
      return Object.freeze({
        schemaVersion: BOT_NAVIGATION_SCHEMA_VERSION,
        capability: 'open_bot',
        status: 'disabled',
        url: null,
      })
    }
    const url = safeTelegramBotUrl(this.configuredUrl)
    if (url === undefined) {
      return Object.freeze({
        schemaVersion: BOT_NAVIGATION_SCHEMA_VERSION,
        capability: 'open_bot',
        status: 'misconfigured',
        url: null,
      })
    }
    return Object.freeze({
      schemaVersion: BOT_NAVIGATION_SCHEMA_VERSION,
      capability: 'open_bot',
      status: 'available',
      url,
    })
  }
}
