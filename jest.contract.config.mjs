/** @type {import('jest').Config} */
const config = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@scripts/(.*)$': '<rootDir>/scripts/$1',
    '^@test/(.*)$': '<rootDir>/test/$1',
  },
  restoreMocks: true,
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/contract/**/*.contract.spec.ts'],
  testTimeout: 10_000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
}

export default config
