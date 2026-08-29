import { GetBotNavigationQuery } from '@/modules/telegram-bot/application/get-bot-navigation.query'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'

const requiredEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://planner:planner@127.0.0.1:5432/planner',
  REDIS_AUTH_URL: 'redis://127.0.0.1:6379',
  AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 91).toString('base64url'),
  AUTH_CSRF_SECRET: Buffer.alloc(32, 92).toString('base64url'),
  AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 93).toString('base64url'),
  AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
  TELEGRAM_OIDC_CLIENT_ID: '123456789',
  TELEGRAM_OIDC_CLIENT_SECRET: 'f09-unit-client-secret',
  TELEGRAM_OIDC_CALLBACK_URL: 'http://127.0.0.1:3000/auth/telegram/callback',
} as const

describe('F09 bot navigation query', () => {
  it('returns only a canonical configured t.me URL', () => {
    expect(
      new GetBotNavigationQuery('https://t.me/planner_pair_bot').execute(),
    ).toEqual({
      schemaVersion: 'telegram.navigation.v1',
      capability: 'open_bot',
      status: 'available',
      url: 'https://t.me/planner_pair_bot',
    })
  })

  it.each([
    'http://t.me/planner_pair_bot',
    'https://evil.example/planner_pair_bot',
    'https://t.me/planner_pair_bot?start=member-id',
    'https://t.me/planner_pair_bot#token',
    'https://user:secret@t.me/planner_pair_bot',
    ' https://t.me/planner_pair_bot',
    '',
  ])('conceals a misconfigured URL: %s', (configuredUrl) => {
    expect(new GetBotNavigationQuery(configuredUrl).execute()).toEqual({
      schemaVersion: 'telegram.navigation.v1',
      capability: 'open_bot',
      status: 'misconfigured',
      url: null,
    })
  })

  it('returns disabled without a configured URL', () => {
    expect(new GetBotNavigationQuery().execute()).toEqual({
      schemaVersion: 'telegram.navigation.v1',
      capability: 'open_bot',
      status: 'disabled',
      url: null,
    })
  })

  it('keeps navigation config separate from ingress mode and bot token', () => {
    const config = buildApiRuntimeConfig({
      ...requiredEnvironment,
      TELEGRAM_INGRESS_MODE: 'disabled',
      TELEGRAM_BOT_TOKEN: '123456789:f09-secret-bot-token',
      TELEGRAM_BOT_URL: 'https://t.me/planner_pair_bot',
    })
    expect(config.telegramBot).toMatchObject({
      ingressMode: 'disabled',
      navigationUrl: 'https://t.me/planner_pair_bot',
    })
    expect(
      new GetBotNavigationQuery(config.telegramBot.navigationUrl).execute(),
    ).toMatchObject({ status: 'available' })
  })
})
