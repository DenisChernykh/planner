import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const backendRoot = process.cwd()
const frontendRoot = resolve(
  backendRoot,
  process.argv[2] ?? '../planner-frontend',
)

const requiredCapabilities = [
  ['F01', 'GET', '/workspace/current', 'WorkspaceController_current'],
  ['F02', 'GET', '/planning/months', 'PlanningMonthController_list'],
  [
    'F03',
    'POST',
    '/planning/drafts/empty',
    'PlanningDraftController_createEmpty',
  ],
  [
    'F04',
    'POST',
    '/planning/drafts/from-publication',
    'PlanningDraftController_createFromPublication',
  ],
  [
    'F05',
    'POST',
    '/planning/drafts/{planMonthId}/focus',
    'PlanningDraftController_updateMonthFocus',
  ],
  [
    'F06',
    'POST',
    '/planning/publications/{publicationId}/cancel',
    'PlanningPublicationController_cancel',
  ],
  [
    'F06',
    'POST',
    '/planning/drafts/{planMonthId}/republish',
    'PlanningDraftController_republish',
  ],
  [
    'F07',
    'GET',
    '/tracking/facts/{factRecordId}/history',
    'FactMaintenanceController_getHistory',
  ],
  [
    'F07',
    'GET',
    '/planning/months/{planMonthId}/history',
    'PlanningMonthController_history',
  ],
  ['F08', 'GET', '/auth/telegram/callback', 'completeTelegramOidcLogin'],
  ['F09', 'GET', '/telegram/navigation', 'getTelegramNavigation'],
]

function fail(message) {
  throw new Error(`Frontend API handoff rejected: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function gitBytes(root, args) {
  return execFileSync('git', args, { cwd: root })
}

function requireAncestor(root, ancestor, descendant, label) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      stdio: 'ignore',
    })
  } catch {
    fail(label)
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(`${label} is not valid JSON`)
  }
}

function operation(document, method, path) {
  return document.paths?.[path]?.[method.toLowerCase()]
}

const [
  backendBytes,
  manifestBytes,
  frontendBytes,
  requiredBytes,
  packageBytes,
] = await Promise.all([
  readFile(resolve(backendRoot, 'docs/api/openapi.json')),
  readFile(resolve(frontendRoot, 'openapi/source.json')),
  readFile(resolve(frontendRoot, 'openapi/openapi.json')),
  readFile(resolve(frontendRoot, 'openapi/required-operations.json')),
  readFile(resolve(frontendRoot, 'package.json')),
])

const backendDocument = parseJson(backendBytes, 'backend OpenAPI')
const manifest = parseJson(manifestBytes, 'frontend source manifest')
const required = parseJson(requiredBytes, 'frontend required operations')
const frontendPackage = parseJson(packageBytes, 'frontend package')
const canonicalRevision = git(backendRoot, [
  'log',
  '-1',
  '--format=%H',
  '--',
  'docs/api/openapi.json',
])
const checksum = sha256(backendBytes)
const committedBackendBytes = gitBytes(backendRoot, [
  'show',
  `${canonicalRevision}:docs/api/openapi.json`,
])

if (!backendBytes.equals(committedBackendBytes)) {
  fail('backend OpenAPI differs from its canonical commit')
}
requireAncestor(
  backendRoot,
  canonicalRevision,
  'origin/main',
  'canonical OpenAPI commit is not contained in local origin/main tracking ref',
)
if (git(frontendRoot, ['status', '--porcelain', '--untracked-files=all'])) {
  fail('frontend consumer worktree is not clean')
}

if (manifest.repository !== 'https://github.com/DenisChernykh/planner') {
  fail('frontend repository provenance differs')
}
if (manifest.artifactPath !== 'docs/api/openapi.json') {
  fail('frontend artifact path differs')
}
if (manifest.revision !== canonicalRevision) {
  fail('frontend revision does not pin the canonical OpenAPI commit')
}
if (manifest.sha256 !== checksum) {
  fail('frontend manifest checksum differs from backend bytes')
}
if (!backendBytes.equals(frontendBytes)) {
  fail('frontend snapshot is not byte-for-byte equal to backend OpenAPI')
}

const requiredOperations = new Map(
  required.operations.map((item) => [
    `${item.method} ${item.path}`,
    item.operationId,
  ]),
)
for (const [card, method, path, operationId] of requiredCapabilities) {
  const backendOperation = operation(backendDocument, method, path)
  if (backendOperation?.operationId !== operationId) {
    fail(`${card} backend operation differs: ${method} ${path}`)
  }
  if (requiredOperations.get(`${method} ${path}`) !== operationId) {
    fail(`${card} frontend required operation differs: ${method} ${path}`)
  }
}

for (const script of ['api:sync', 'api:generate', 'api:check', 'check']) {
  if (typeof frontendPackage.scripts?.[script] !== 'string') {
    fail(`frontend script ${script} is missing`)
  }
}
const workflow = await readFile(
  resolve(frontendRoot, '.github/workflows/source-check.yml'),
  'utf8',
)
if (!workflow.includes('run: pnpm check')) {
  fail('frontend CI does not run the local pnpm check gate')
}

const generatedSource = await readFile(
  resolve(frontendRoot, 'src/shared/api/generated-zod/contract-source.ts'),
  'utf8',
)
if (
  !generatedSource.includes(`revision: '${canonicalRevision}'`) ||
  !generatedSource.includes(`sha256: '${checksum}'`)
) {
  fail('generated contract source differs from the manifest')
}

process.stdout.write(
  [
    'Frontend API handoff: verified',
    `backendOpenApiRevision=${canonicalRevision}`,
    `frontendHead=${git(frontendRoot, ['rev-parse', 'HEAD'])}`,
    `sha256=${checksum}`,
    `requiredCapabilities=${requiredCapabilities.length}`,
  ].join('\n') + '\n',
)
