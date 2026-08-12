import type {
  DraftGoalConfigV1 as DomainDraftGoalConfigV1,
  GoalConfigV1 as DomainGoalConfigV1,
  SourceProvenanceV1 as DomainSourceProvenanceV1,
} from '../domain/goal-config'
import { snapshotStoredDraftGoalConfig } from '../domain/goal-config'
import {
  validateGoalConfig as validateDomainGoalConfig,
  type GoalConfigValidationResult as DomainGoalConfigValidationResult,
  type PublishBlocker as DomainPublishBlocker,
  type PublishBlockerCode as DomainPublishBlockerCode,
} from '../domain/goal-validation'

export type DraftGoalConfigV1 = DomainDraftGoalConfigV1
export type GoalConfigV1 = DomainGoalConfigV1
export type SourceProvenanceV1 = DomainSourceProvenanceV1
export type PublishBlockerCode = DomainPublishBlockerCode
export type PublishBlocker = DomainPublishBlocker
export type GoalConfigValidationResult = DomainGoalConfigValidationResult

export function validateGoalConfig(
  planGoalId: string,
  config: DraftGoalConfigV1,
): GoalConfigValidationResult {
  return validateDomainGoalConfig(
    planGoalId,
    snapshotStoredDraftGoalConfig(config),
  )
}
