type PlanningTick = { tick(): Promise<void> }
type ReminderTick = { execute(signal: AbortSignal): Promise<unknown> }

export function composePlannerWorkerTick(
  planning: PlanningTick,
  reminders: ReminderTick,
): (signal: AbortSignal) => Promise<void> {
  return async (signal: AbortSignal): Promise<void> => {
    await planning.tick()
    await reminders.execute(signal)
  }
}
