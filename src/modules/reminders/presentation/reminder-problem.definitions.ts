import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const REMINDER_AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'reminder-authorization-denied',
  code: 'REMINDER_AUTHORIZATION_DENIED',
  status: 403,
  title: 'Reminder authorization denied',
  detail: 'The current principal cannot access these reminder settings.',
})

export const REMINDER_SCHEDULE_REVISION_CONFLICT_PROBLEM =
  defineProblemDefinition({
    slug: 'reminder-schedule-revision-conflict',
    code: 'REMINDER_SCHEDULE_REVISION_CONFLICT',
    status: 409,
    title: 'Reminder schedule revision conflict',
    detail: 'The reminder settings changed before this request was applied.',
  })
