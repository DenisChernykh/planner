export type UserId = string & { readonly __userId: unique symbol }

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function toUserId(value: string): UserId {
  if (!uuidPattern.test(value)) throw new Error('Invalid UserId')
  return value as UserId
}
