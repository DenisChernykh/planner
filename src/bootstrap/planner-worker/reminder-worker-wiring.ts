type PlanningTick = { tick(signal: AbortSignal): Promise<void> }
type ReminderTick = { execute(signal: AbortSignal): Promise<unknown> }

export function composePlannerWorkerTick(
  planning: PlanningTick,
  reminders: ReminderTick,
): (signal: AbortSignal) => Promise<void> {
  return async (signal: AbortSignal): Promise<void> => {
    await planning.tick(signal)
    await reminders.execute(signal)
  }
}
