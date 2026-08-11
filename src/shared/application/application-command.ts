export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject

export type CanonicalJsonObject = {
  readonly [key: string]: CanonicalJsonValue
}

export type ActorRef =
  | { readonly kind: 'member'; readonly id: string }
  | { readonly kind: 'system'; readonly id: 'planner-worker' }

export type ApplicationCommand<TPayload> = {
  readonly commandId: string
  readonly trustedActor: ActorRef
  readonly expectedRevision?: bigint
  readonly payload: TPayload
}

export type DurableCommandResultRef<K extends string = string> = {
  readonly kind: K
  readonly aggregateId: string
  readonly aggregateRevision: bigint
}

export type CommandExecutionContext = {
  readonly occurredAt: Date
}

export type CommandDefinition<TPayload, K extends string> = {
  readonly commandType: string
  readonly resultKind: K
  readonly toCanonicalPayload: (payload: TPayload) => CanonicalJsonObject
}

export interface CommandExecutor {
  execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>>
}

export class CommandValidationError extends Error {
  public constructor() {
    super('Application command is invalid')
    this.name = 'CommandValidationError'
  }
}

export class CommandFingerprintConflictError extends Error {
  public constructor() {
    super('Command key has already completed with a different fingerprint')
    this.name = 'CommandFingerprintConflictError'
  }
}
