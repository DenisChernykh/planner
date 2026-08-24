export class PairProvisioningInputError extends Error {
  public constructor() {
    super('Invalid pair provisioning input')
    this.name = 'PairProvisioningInputError'
  }
}

export class PairProvisioningConflictError extends Error {
  public constructor() {
    super('Pair provisioning state conflicts with the requested mapping')
    this.name = 'PairProvisioningConflictError'
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  public constructor() {
    super('Workspace member was not found')
    this.name = 'WorkspaceMemberNotFoundError'
  }
}

export class WorkspaceTelegramRecipientNotFoundError extends Error {
  public constructor() {
    super('Workspace Telegram recipient was not found')
    this.name = 'WorkspaceTelegramRecipientNotFoundError'
  }
}

export class WorkspaceDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Workspace dependency is unavailable', options)
    this.name = 'WorkspaceDependencyUnavailableError'
  }
}

export class CurrentWorkspaceAuthorizationDeniedError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Current workspace access is denied', options)
    this.name = 'CurrentWorkspaceAuthorizationDeniedError'
  }
}

export class CurrentWorkspaceStateConflictError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Current workspace state is inconsistent', options)
    this.name = 'CurrentWorkspaceStateConflictError'
  }
}

export class CurrentWorkspaceDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Current workspace dependency is unavailable', options)
    this.name = 'CurrentWorkspaceDependencyUnavailableError'
  }
}
