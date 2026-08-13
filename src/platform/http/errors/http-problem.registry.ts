import type {
  HttpProblemContribution,
  MappedHttpProblem,
  RegisteredProblemDefinition,
} from './problem.contracts'

export class HttpProblemRegistry {
  public readonly definitions: readonly RegisteredProblemDefinition[]
  readonly #byCode: ReadonlyMap<string, RegisteredProblemDefinition>
  readonly #internal: RegisteredProblemDefinition

  public constructor(
    private readonly contributions: readonly HttpProblemContribution[],
  ) {
    const definitions = contributions.flatMap(
      (contribution) => contribution.definitions,
    )
    const codes = new Set<string>()
    const slugs = new Set<string>()
    const types = new Set<string>()
    for (const definition of definitions) {
      if (
        codes.has(definition.code) ||
        slugs.has(definition.slug) ||
        types.has(definition.type)
      ) {
        throw new Error(`Duplicate HTTP problem definition: ${definition.code}`)
      }
      codes.add(definition.code)
      slugs.add(definition.slug)
      types.add(definition.type)
    }
    this.definitions = Object.freeze(
      definitions.map((definition) => Object.freeze({ ...definition })),
    )
    this.#byCode = new Map(
      this.definitions.map((definition) => [definition.code, definition]),
    )
    for (const contribution of contributions) {
      for (const code of contribution.mappedCodes) {
        if (!this.#byCode.has(code)) {
          throw new Error(`Unregistered HTTP problem mapping: ${code}`)
        }
      }
    }
    const internal = this.#byCode.get('INTERNAL_ERROR')
    if (internal === undefined)
      throw new Error(
        'HTTP problem registry requires an INTERNAL_ERROR definition',
      )
    this.#internal = internal
  }

  public map(error: unknown): MappedHttpProblem {
    for (const contribution of this.contributions) {
      const mapped = contribution.map(error)
      if (mapped === undefined) continue
      const definition = this.#byCode.get(mapped.code)
      if (definition !== undefined) {
        return {
          definition,
          ...(mapped.errors === undefined ? {} : { errors: mapped.errors }),
          ...(mapped.conflict === undefined
            ? {}
            : { conflict: mapped.conflict }),
          ...(mapped.blockers === undefined
            ? {}
            : { blockers: mapped.blockers }),
          unexpected: false,
        }
      }
      return { definition: this.#internal, unexpected: true }
    }
    return { definition: this.#internal, unexpected: true }
  }
}
