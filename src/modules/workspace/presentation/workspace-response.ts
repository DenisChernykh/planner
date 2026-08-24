import type { CurrentWorkspaceView } from '../application/get-current-workspace.query'

export type WorkspaceCurrentResponseV1 = CurrentWorkspaceView

export function toWorkspaceCurrentResponse(
  view: CurrentWorkspaceView,
): WorkspaceCurrentResponseV1 {
  return view
}
