import { composePlannerWorkerTick } from '@/bootstrap/planner-worker/reminder-worker-wiring'

describe('N05 planner-worker reminder wiring', () => {
  it('runs planning before reminders for both startup and periodic ticks', async () => {
    const events: string[] = []
    const planning = {
      tick: jest.fn(() => {
        events.push('planning')
        return Promise.resolve()
      }),
    }
    const reminders = {
      execute: jest.fn((signal: AbortSignal) => {
        events.push(signal.aborted ? 'reminders-aborted' : 'reminders')
        return Promise.resolve({
          claimed: 0,
          suppressed: 0,
          prepared: 0,
          delivered: 0,
        })
      }),
    }
    const tick = composePlannerWorkerTick(planning, reminders)
    const signal = new AbortController().signal

    await tick(signal)

    expect(events).toEqual(['planning', 'reminders'])
    expect(reminders.execute).toHaveBeenCalledWith(signal)
  })

  it('does not admit reminder work when planning fails', async () => {
    const error = new Error('planning failure')
    const planning = { tick: jest.fn().mockRejectedValue(error) }
    const reminders = {
      execute: jest.fn().mockResolvedValue({
        claimed: 0,
        suppressed: 0,
        prepared: 0,
        delivered: 0,
      }),
    }

    await expect(
      composePlannerWorkerTick(
        planning,
        reminders,
      )(new AbortController().signal),
    ).rejects.toBe(error)
    expect(reminders.execute).not.toHaveBeenCalled()
  })
})
