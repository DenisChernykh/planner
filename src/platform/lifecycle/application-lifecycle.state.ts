import { Injectable } from '@nestjs/common'

export type ApplicationPhase = 'starting' | 'ready' | 'draining'

@Injectable()
export class ApplicationLifecycleState {
  private currentPhase: ApplicationPhase = 'starting'
  private startupLatch = false

  public get phase(): ApplicationPhase {
    return this.currentPhase
  }

  public get startupComplete(): boolean {
    return this.startupLatch
  }

  public markReady(): void {
    if (this.currentPhase !== 'starting') return
    this.currentPhase = 'ready'
    this.startupLatch = true
  }

  public beginDrain(): boolean {
    if (this.currentPhase === 'draining') return false
    this.currentPhase = 'draining'
    return true
  }
}
