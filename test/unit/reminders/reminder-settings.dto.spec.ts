import { validate } from 'class-validator'

import { SaveReminderSettingsRequestDto } from '@/modules/reminders/presentation/reminder-settings.dto'

function request(expectedRevision: unknown): SaveReminderSettingsRequestDto {
  return Object.assign(new SaveReminderSettingsRequestDto(), {
    commandId: '11111111-1111-4111-8111-111111111111',
    expectedRevision,
    timeZone: 'Asia/Yekaterinburg',
    morning: null,
    day: null,
    evening: null,
  })
}

describe('N04 reminder settings request DTO', () => {
  it('rejects null expectedRevision while allowing it to be omitted', async () => {
    await expect(validate(request(undefined))).resolves.toEqual([])
    await expect(validate(request(null))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'expectedRevision' }),
      ]),
    )
  })
})
