export function readCanonicalSessionToken(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (cookieHeader === undefined) return undefined
  const values = cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${cookieName}=`))
    .map((entry) => entry.slice(cookieName.length + 1))
  if (values.length !== 1) return undefined
  const value = values[0]
  if (value === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    return undefined
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === value
    ? value
    : undefined
}
