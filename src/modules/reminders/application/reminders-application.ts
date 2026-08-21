import type { BuildReminderIntentCommand } from './build-reminder-intent.command'
import type { ClaimDueOccurrences } from './claim-due-occurrences.command'
import type { DeliverReminderCommand } from './deliver-reminder.command'
import type { GetDeliveryStatusQuery } from './get-delivery-status.query'
import type { GetReminderSettingsQuery } from './get-reminder-settings.query'
import type { SaveReminderScheduleCommand } from './save-reminder-schedule.command'
import type { RunDueRemindersCycle } from './run-due-reminders.cycle'

export const REMINDERS_APPLICATION: unique symbol = Symbol(
  'REMINDERS_APPLICATION',
)

export type RemindersApplication = {
  readonly saveReminderSchedule: SaveReminderScheduleCommand
  readonly getReminderSettings: GetReminderSettingsQuery
  readonly getDeliveryStatus: GetDeliveryStatusQuery
  readonly claimDueOccurrences: ClaimDueOccurrences
  readonly buildReminderIntent: BuildReminderIntentCommand
  readonly deliverReminder?: DeliverReminderCommand
  readonly runDueReminders?: RunDueRemindersCycle
}
