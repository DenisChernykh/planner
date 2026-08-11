import type { GracefulShutdownResult } from './graceful-shutdown'

export type ProcessExit = (code: number) => void

export interface ProcessSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void
  off(signal: NodeJS.Signals, listener: () => void): void
}

export interface ShutdownCoordinator {
  shutdown(reason: string): Promise<GracefulShutdownResult>
}

export interface WatchdogHandle {
  cancel(): void
}

export type WatchdogScheduler = (
  expire: () => void,
  milliseconds: number,
) => WatchdogHandle

const scheduleWatchdog: WatchdogScheduler = (expire, milliseconds) => {
  const timer = setTimeout(expire, milliseconds)
  return { cancel: () => clearTimeout(timer) }
}

export function installProcessSignalHandlers(
  coordinator: ShutdownCoordinator,
  graceMs: number,
  exit: ProcessExit = (code) => process.exit(code),
  source: ProcessSignalSource = process,
  watchdogScheduler: WatchdogScheduler = scheduleWatchdog,
): () => void {
  let handling: Promise<void> | undefined
  let watchdog: WatchdogHandle | undefined
  const handle = (reason: string): void => {
    handling ??= (async () => {
      let exited = false
      const exitOnce = (code: number): void => {
        if (exited) return
        exited = true
        exit(code)
      }
      watchdog = watchdogScheduler(() => exitOnce(1), graceMs)
      const exitCode = await coordinator
        .shutdown(reason)
        .then((result) => result.exitCode)
        .catch(() => 1 as const)
      watchdog.cancel()
      watchdog = undefined
      exitOnce(exitCode)
    })()
  }
  const term = (): void => handle('SIGTERM')
  const interrupt = (): void => handle('SIGINT')
  source.on('SIGTERM', term)
  source.on('SIGINT', interrupt)
  return () => {
    source.off('SIGTERM', term)
    source.off('SIGINT', interrupt)
    watchdog?.cancel()
  }
}
