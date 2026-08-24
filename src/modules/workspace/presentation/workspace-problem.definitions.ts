import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const WORKSPACE_AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'workspace-authorization-denied',
  code: 'WORKSPACE_AUTHORIZATION_DENIED',
  status: 403,
  title: 'Workspace authorization denied',
  detail: 'The current principal is not a member of the workspace.',
})

export const WORKSPACE_STATE_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'workspace-state-conflict',
  code: 'WORKSPACE_STATE_CONFLICT',
  status: 409,
  title: 'Workspace state conflict',
  detail: 'The workspace pair state is inconsistent.',
})
