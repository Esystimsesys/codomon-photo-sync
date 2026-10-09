import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeAutoSend } from '../src/shared/send';

const auto = { miteneEnabled: true, sendMode: 'automatic' as const, autoSendFrom: '2026-10-09' };
test('automatic sending only covers photos that reached parents on or after the day it was turned on', () => {
  assert.equal(beforeAutoSend({ date: '2026-10-09' }, auto), false, 'the same day is included');
  assert.equal(beforeAutoSend({ date: '2026-10-08' }, auto), true);
  assert.equal(beforeAutoSend({ date: '2026-10-08', postedDate: '2026-10-10' }, auto), false, 'a backdated post that arrived later is sent');
  assert.equal(beforeAutoSend({ date: '2026-10-10', postedDate: '2026-10-08' }, auto), true);
  assert.equal(beforeAutoSend({ date: 'unknown-date' }, auto), true, 'unknown dates are never sent automatically');
  assert.equal(beforeAutoSend({ date: '2026-10-10' }, { ...auto, autoSendFrom: '' }), true, 'a missing start date sends nothing automatically');
  assert.equal(beforeAutoSend({ date: '2026-10-08' }, { ...auto, sendMode: 'review' }), false, 'review mode is not restricted');
});
