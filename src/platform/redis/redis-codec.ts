export type RedisDecodeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false }

export interface RedisCodec<T> {
  encode(value: T): string
  decode(serialized: string): RedisDecodeResult<T>
}
