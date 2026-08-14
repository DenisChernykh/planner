export interface WorkerApplication {
  close(): Promise<void>
}

export type WorkerTerminationWaiter = (
  close: () => Promise<void>,
) => Promise<void>

export interface RunWorkerApplicationInput {
  readonly application: WorkerApplication
  readonly shutdownGraceMs: number
  readonly onStarted: () => void
  readonly forceExit: (code: number) => void
  readonly waitForTermination?: WorkerTerminationWaiter
}

function closeWithDeadline(
  close: () => Promise<void>,
  shutdownGraceMs: number,
  forceExit: (code: number) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      forceExit(1)
      reject(new Error('Worker application close exceeded shutdown grace'))
    }, shutdownGraceMs)
  })
  const closing = Promise.resolve().then(close)
  return Promise.race([closing, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export function waitForWorkerTermination(
  close: () => Promise<void>,
  stopListening?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let signalAccepted = false
    const cleanup = (): void => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      stopListening?.removeEventListener('abort', onStopListening)
    }
    const onStopListening = (): void => {
      cleanup()
      resolve()
    }
    const onSignal = (): void => {
      if (signalAccepted) return
      signalAccepted = true
      Promise.resolve().then(close).then(resolve, reject).finally(cleanup)
    }
    if (stopListening?.aborted === true) {
      resolve()
      return
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    stopListening?.addEventListener('abort', onStopListening, { once: true })
  })
}

export async function runWorkerApplication(
  input: RunWorkerApplicationInput,
): Promise<void> {
  let closePromise: Promise<void> | undefined
  const closeOnce = (): Promise<void> => {
    closePromise ??= closeWithDeadline(
      () => input.application.close(),
      input.shutdownGraceMs,
      input.forceExit,
    )
    return closePromise
  }
  const waitForTermination =
    input.waitForTermination ?? waitForWorkerTermination
  try {
    input.onStarted()
    await waitForTermination(closeOnce)
  } catch (error: unknown) {
    await closeOnce().catch(() => undefined)
    throw error
  }
}
