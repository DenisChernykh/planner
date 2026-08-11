import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { appMetadata } from '@/app-metadata'

type PackageManifest = {
  name: unknown
  engines: Record<string, unknown>
  packageManager: unknown
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const packageManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as PackageManifest

const excludedDependencies = [
  '@microsoft/tsdoc',
  '@nestjs/bullmq',
  '@types/nodemailer',
  'argon2',
  'bullmq',
  'eslint-plugin-jsdoc',
  'eslint-plugin-tsdoc',
  'husky',
  'ioredis',
  'lint-staged',
  'nodemailer',
] as const

describe('Planner toolchain skeleton', () => {
  it('exposes metadata for Planner build consumers', () => {
    expect(appMetadata).toEqual({ name: 'planner', nodeMajor: 24 })
  })

  it('pins the supported toolchain without excluded foundations', () => {
    expect(packageManifest).toMatchObject({
      name: 'planner',
      engines: {
        node: '>=24 <25',
        pnpm: '11.15.1',
      },
      packageManager: 'pnpm@11.15.1',
    })

    expect(Object.values(packageManifest.scripts).join('\n')).not.toContain(
      'corepack',
    )

    const dependencyNames = new Set([
      ...Object.keys(packageManifest.dependencies ?? {}),
      ...Object.keys(packageManifest.devDependencies ?? {}),
    ])

    expect(
      excludedDependencies.filter((name) => dependencyNames.has(name)),
    ).toEqual([])
  })
})
