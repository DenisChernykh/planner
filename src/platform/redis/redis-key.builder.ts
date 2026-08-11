const safeSegment = /^[A-Za-z0-9._-]+$/u

export class RedisKeyBuilder {
  private readonly namespace: readonly string[]

  public constructor(namespace: string | readonly string[], schema: string) {
    this.namespace = Object.freeze(
      typeof namespace === 'string'
        ? [namespace, schema]
        : [...namespace, schema],
    )
    if (
      this.namespace.length < 2 ||
      this.namespace.some((value) => !safeSegment.test(value))
    ) {
      throw new Error('Redis key namespace rejected')
    }
  }

  public build(resource: string, ...segments: readonly string[]): string {
    if (![resource, ...segments].every((value) => safeSegment.test(value))) {
      throw new Error('Redis key segment rejected')
    }
    return [...this.namespace, resource, ...segments].join(':')
  }
}
