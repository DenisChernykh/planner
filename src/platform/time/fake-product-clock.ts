import type { ProductClock } from '@/shared/application/product-clock'

export class FakeProductClock implements ProductClock {
  private value: Date

  public constructor(initial: Date) {
    this.value = new Date(initial.getTime())
  }

  public set(value: Date): void {
    this.value = new Date(value.getTime())
  }

  public now(): Date {
    return new Date(this.value.getTime())
  }

  public today(timeZone: 'Asia/Yekaterinburg'): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.now())
  }
}
