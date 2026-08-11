import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto'

export type AuthRandomBytesSource = (size: number) => Buffer

function canonicalBytes(value: string, size?: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.toString('base64url') !== value ||
    (size !== undefined && decoded.length !== size)
  ) {
    return undefined
  }
  return decoded
}

export class NodeAuthCryptoAdapter {
  public constructor(
    private readonly randomBytes: AuthRandomBytesSource = nodeRandomBytes,
  ) {}

  public generateSessionToken(): string {
    return this.randomBytes(32).toString('base64url')
  }

  public generateSessionId(): string {
    return this.randomBytes(16).toString('base64url')
  }

  public generateCsrfSeed(): string {
    return this.randomBytes(32).toString('base64url')
  }

  public hmac(key: Uint8Array, value: string): string {
    return createHmac('sha256', key).update(value, 'utf8').digest('base64url')
  }

  public constantTimeEqual(left: string, right: string): boolean {
    const leftBytes = canonicalBytes(left)
    const rightBytes = canonicalBytes(right)
    if (
      leftBytes === undefined ||
      rightBytes === undefined ||
      leftBytes.length !== rightBytes.length
    ) {
      return false
    }
    return timingSafeEqual(leftBytes, rightBytes)
  }
}

export function isCanonicalBase64Url(
  value: unknown,
  size: number,
): value is string {
  return typeof value === 'string' && canonicalBytes(value, size) !== undefined
}
