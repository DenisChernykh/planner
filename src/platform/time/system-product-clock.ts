import type { ProductClock } from '@/shared/application/product-clock'

export class SystemProductClock implements ProductClock {
  public constructor(private readonly readNow: () => Date = () => new Date()) {}

  public now(): Date {
    return new Date(this.readNow().getTime())
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
