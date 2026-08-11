import { Global, Module } from '@nestjs/common'

import { ApplicationLifecycleState } from './application-lifecycle.state'

@Global()
@Module({
  providers: [ApplicationLifecycleState],
  exports: [ApplicationLifecycleState],
})
export class LifecycleModule {}
