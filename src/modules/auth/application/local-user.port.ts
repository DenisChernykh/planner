import type { UserId } from '../domain/user-id'

export interface LocalUserPort {
  exists(userId: string): Promise<boolean>
}

export const LOCAL_USER_PORT: unique symbol = Symbol('LOCAL_USER_PORT')

export function existingUserId(value: string): UserId {
  return value as UserId
}
