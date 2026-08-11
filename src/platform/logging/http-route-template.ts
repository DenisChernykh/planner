import type { Request } from 'express'

export function resolveHttpRouteTemplate(request: Request): string {
  const route: unknown = request.route
  const path =
    route !== null &&
    typeof route === 'object' &&
    'path' in route &&
    typeof route.path === 'string'
      ? route.path
      : undefined
  if (path === undefined || !path.startsWith('/')) return 'unmatched'
  const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : ''
  return baseUrl.length === 0 ? path : `${baseUrl.replace(/\/$/u, '')}${path}`
}
