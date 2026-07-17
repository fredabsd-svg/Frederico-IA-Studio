import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeScheduleDay,
  resolveScheduleTimeZone,
  scheduleDateKey,
  scheduleDue
} from './scheduling.js';

const TIME_ZONE = 'America/Araguaina';

test('keeps Sunday as weekday zero instead of silently changing it to Monday', () => {
  assert.equal(normalizeScheduleDay('weekly', 0), 0);
  const sundayAtEight = new Date('2026-07-12T11:00:00.000Z'); // 08:00 Sunday in Araguaina
  assert.equal(scheduleDue({ enabled: 1, cadence: 'weekly', day: 0, hour: 8 }, sundayAtEight, TIME_ZONE), true);
});

test('uses the configured local date instead of UTC when deciding whether a routine already ran', () => {
  const localEvening = new Date('2026-07-17T01:30:00.000Z'); // 22:30 of July 16 in Araguaina
  assert.equal(scheduleDateKey(localEvening, TIME_ZONE), '2026-07-16');
  assert.equal(scheduleDue({ enabled: 1, cadence: 'daily', day: 1, hour: 8, last_run: '2026-07-16' }, localEvening, TIME_ZONE), false);
});

test('clamps a monthly day to the last day of a shorter month', () => {
  const february = new Date('2026-02-28T12:00:00.000Z');
  assert.equal(scheduleDue({ enabled: 1, cadence: 'monthly', day: 31, hour: 8 }, february, TIME_ZONE), true);
});

test('falls back safely when a configured time zone is invalid', () => {
  assert.equal(resolveScheduleTimeZone('not/a-zone'), 'UTC');
});
