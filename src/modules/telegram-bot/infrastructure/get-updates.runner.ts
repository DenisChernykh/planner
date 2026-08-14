import { setTimeout as delay } from 'node:timers/promises'

import type {
  TelegramBotApiPort,
  TelegramIngressLifecycle,
  TelegramIngressStatePort,
  TelegramPreparedAttempt,
} from '../application/telegram-bot.types'
import type { TelegramUpdateHandler } from '../application/telegram-update.handler'
import { normalizeTelegramUpdate } from '../application/telegram-update.normalizer'

export class DisabledTelegramIngress implements TelegramIngressLifecycle {
  public start(): Promise<void> {
    return Promise.resolve()
  }

  public stop(): Promise<void> {
    return Promise.resolve()
  }
}

export class GetUpdatesRunner implements TelegramIngressLifecycle {
  private controller: AbortController | undefined
  private readonly outboundController = new AbortController()
  private inFlight: Promise<void> | undefined
  private loop: Promise<void> | undefined
  private started = false

  public constructor(
    private readonly state: TelegramIngressStatePort,
    private readonly botApi: TelegramBotApiPort,
    private readonly handler: TelegramUpdateHandler,
    private readonly timeoutSeconds: number,
  ) {}

  public async start(signal: AbortSignal): Promise<void> {
    if (this.started) throw new Error('Telegram ingress already started')
    this.started = true
    this.controller = new AbortController()
    const startupSignal = AbortSignal.any([signal, this.controller.signal])
    const initial = this.tick(0, startupSignal)
    this.inFlight = initial
    try {
      await initial
    } finally {
      if (this.inFlight === initial) this.inFlight = undefined
    }
    if (startupSignal.aborted) throw new Error('Telegram ingress start aborted')
    this.loop = this.run(this.controller.signal)
  }

  public async stop(signal: AbortSignal): Promise<void> {
    const abortOutbound = (): void => this.outboundController.abort()
    if (signal.aborted) abortOutbound()
    else signal.addEventListener('abort', abortOutbound, { once: true })
    this.controller?.abort()
    const pending = this.loop ?? this.inFlight
    if (pending === undefined) {
      signal.removeEventListener('abort', abortOutbound)
      return
    }
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          const abort = (): void =>
            reject(new Error('Telegram ingress stop timed out'))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      signal.removeEventListener('abort', abortOutbound)
    }
  }

  public async tick(
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    const offset = await this.state.getNextUpdateId()
    const raw = await this.botApi.getUpdates({
      offset,
      timeoutSeconds,
      signal,
    })
    const updates = raw
      .map((value) => normalizeTelegramUpdate(value))
      .sort((left, right) =>
        left.updateId < right.updateId
          ? -1
          : left.updateId > right.updateId
            ? 1
            : 0,
      )
    for (const update of updates) {
      if (signal.aborted) return
      const prepared = await this.handler.prepare(update)
      if (signal.aborted) return
      if (!(await this.state.claim(update.updateId))) continue
      for (const attempt of prepared.attempts) {
        await this.attempt(attempt, this.outboundController.signal).catch(
          () => undefined,
        )
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const operation = this.tick(this.timeoutSeconds, signal)
        this.inFlight = operation
        await operation
      } catch {
        if (signal.aborted) return
        await delay(1_000, undefined, { signal }).catch(() => undefined)
      } finally {
        this.inFlight = undefined
      }
    }
  }

  private attempt(
    attempt: TelegramPreparedAttempt,
    signal: AbortSignal,
  ): Promise<void> {
    return attempt.kind === 'answer_callback'
      ? this.botApi.answerCallbackQuery(attempt, signal)
      : this.botApi.sendMessage(attempt, signal)
  }
}
