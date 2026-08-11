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

export class WorkspaceDependencyUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Workspace dependency is unavailable', options)
    this.name = 'WorkspaceDependencyUnavailableError'
  }
}
