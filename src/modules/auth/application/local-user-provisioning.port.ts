export interface LocalUserProvisioningPort {
  ensureUsers(userIds: readonly string[]): Promise<void>
}

export const LOCAL_USER_PROVISIONING_PORT: unique symbol = Symbol(
  'LOCAL_USER_PROVISIONING_PORT',
)

export class LocalUserProvisioningUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Local User provisioning is unavailable', options)
    this.name = 'LocalUserProvisioningUnavailableError'
  }
}
