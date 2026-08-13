import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  SeedOwnerBindingInput,
  SeedOwnerBindingPort,
  SeedOwnerBindings,
} from '../application/seed-owner-binding.port'

type MemberRow = { readonly id: string }

export class PrismaSeedOwnerBinding implements SeedOwnerBindingPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public resolvePair(input: SeedOwnerBindingInput): Promise<SeedOwnerBindings> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<MemberRow[]>`
        SELECT id::text
          FROM memberships
         WHERE space_id = ${input.spaceId}::uuid
         ORDER BY id
         FOR SHARE
      `
      if (
        rows.length !== 2 ||
        !rows.some((row) => row.id === input.actorMemberId)
      ) {
        throw new Error('Seed owner binding requires an exact member pair')
      }
      const other = rows.find((row) => row.id !== input.actorMemberId)
      if (other === undefined) {
        throw new Error('Seed owner binding requires distinct members')
      }
      return input.actorPersona === 'memberA'
        ? Object.freeze({
            denisMemberId: input.actorMemberId,
            tanyaMemberId: other.id,
          })
        : Object.freeze({
            denisMemberId: other.id,
            tanyaMemberId: input.actorMemberId,
          })
    })
  }
}
