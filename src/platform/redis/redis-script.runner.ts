import type { RedisCommandExecutorPort } from './redis-command.executor'

export interface RedisScriptDefinition {
  readonly name: string
  readonly source: string
}

interface RegisteredScript {
  readonly source: string
  sha: string | undefined
  loadPromise: Promise<string> | undefined
}

export class RedisScriptRunner {
  private readonly scripts = new Map<string, RegisteredScript>()

  public constructor(private readonly executor: RedisCommandExecutorPort) {}

  public register(definition: RedisScriptDefinition): void {
    if (
      !/^[A-Za-z0-9._-]+$/u.test(definition.name) ||
      definition.source.trim() === '' ||
      this.scripts.has(definition.name)
    )
      throw new Error('Redis script registration rejected')
    this.scripts.set(definition.name, {
      source: definition.source,
      sha: undefined,
      loadPromise: undefined,
    })
  }

  public async run<T>(
    name: string,
    keys: readonly string[],
    arguments_: readonly string[],
    signal?: AbortSignal,
  ): Promise<T> {
    if (keys.length === 0) throw new Error('Redis script requires a key')
    const script = this.scripts.get(name)
    if (script === undefined) throw new Error('Redis script is not registered')
    const execute = async (): Promise<T> => {
      const sha = await this.load(name, script, signal)
      return this.executor.execute(
        `script:${name}`,
        (client) =>
          client.sendCommand<T>([
            'EVALSHA',
            sha,
            String(keys.length),
            ...keys,
            ...arguments_,
          ]),
        signal,
      )
    }
    try {
      return await execute()
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT'))
        throw error
      script.sha = undefined
      return execute()
    }
  }

  private async load(
    name: string,
    script: RegisteredScript,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (script.sha !== undefined) return script.sha
    script.loadPromise ??= this.executor.execute(
      `script-load:${name}`,
      (client) => client.sendCommand<string>(['SCRIPT', 'LOAD', script.source]),
      signal,
    )
    try {
      const sha = await script.loadPromise
      if (!/^[a-f0-9]{40}$/u.test(sha))
        throw new Error('Invalid Redis script digest')
      script.sha = sha
      return sha
    } finally {
      script.loadPromise = undefined
    }
  }
}
