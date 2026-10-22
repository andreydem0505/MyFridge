import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBatch, transitionBatch, defaultSettings, batchInputSchema, type Batch } from '../shared/model.js';

const now = new Date('2026-10-22T09:00:00.000Z');
export function batch(overrides: Partial<Batch> = {}): Batch {
  return { id: 'one', name: 'Молоко', quantity: 1, unit: 'л', labelExpiresOn: '2026-10-25',
    packaged: true, isOpen: false, openedAt: null, afterOpenHours: 36,
    storage: 'fridge', requiredStorage: 'fridge', afterOpeningStorage: null,
    minTemp: 2, maxTemp: 6, notes: '', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    spoiledAt: null, consumedAt: null, storageConcern: null, demo: false, ...overrides };
}
test('дата на этикетке действует до конца дня в выбранном часовом поясе', () => {
  assert.equal(evaluateBatch(batch(), defaultSettings, now).deadline, '2026-10-25T20:59:59.999Z');
  assert.equal(evaluateBatch(batch(), { ...defaultSettings, timezone: 'UTC' }, now).deadline, '2026-10-25T23:59:59.999Z');
});
test('вскрытие сокращает срок; более длинный срок после вскрытия не продлевает этикетку', () => {
  const opened = batch({ isOpen: true, openedAt: now.toISOString() });
  assert.equal(evaluateBatch(opened, defaultSettings, now).deadline, '2026-10-23T21:00:00.000Z');
  assert.equal(evaluateBatch({ ...opened, afterOpenHours: 240 }, defaultSettings, now).deadline, '2026-10-25T20:59:59.999Z');
});
test('повторное закрытие и открытие не сбрасывает первое вскрытие', () => {
  const opened = transitionBatch(batch(), { isOpen: true }, now);
  const closed = transitionBatch(opened, { isOpen: false }, new Date('2026-10-22T12:00:00Z'));
  const reopened = transitionBatch(closed, { isOpen: true }, new Date('2026-10-23T08:00:00Z'));
  assert.equal(reopened.openedAt, now.toISOString());
  assert.equal(evaluateBatch(opened, defaultSettings, now).deadline, evaluateBatch(reopened, defaultSettings, now).deadline);
  assert.throws(() => transitionBatch(reopened, { openedAt: null }, now), /не обнуляет/);
});
test('открытый продукт без срока после вскрытия требует уточнения', () => {
  const result = evaluateBatch(batch({ openedAt: now.toISOString(), isOpen: true, afterOpenHours: null }), defaultSettings, now);
  assert.equal(result.status, 'review'); assert.equal(result.eligible, false);
});
test('учитываются условия после вскрытия и температура', () => {
  const item = batch({ storage: 'pantry', requiredStorage: 'pantry', minTemp: null, maxTemp: null, afterOpeningStorage: 'fridge' });
  assert.equal(evaluateBatch(item, defaultSettings, now).eligible, true);
  assert.equal(evaluateBatch({ ...item, openedAt: now.toISOString() }, defaultSettings, now).eligible, false);
  assert.equal(evaluateBatch(batch(), { ...defaultSettings, temperatures: { ...defaultSettings.temperatures, fridge: 10 } }, now).status, 'review');
});
test('просроченные, испорченные и использованные партии исключаются', () => {
  for (const changes of [{ labelExpiresOn: '2026-10-21' }, { spoiledAt: now.toISOString() }, { consumedAt: now.toISOString() }]) {
    assert.equal(evaluateBatch(batch(changes), defaultSettings, now).eligible, false);
  }
  assert.equal(evaluateBatch(batch({ spoiledAt: now.toISOString() }), defaultSettings, now).status, 'spoiled');
});
test('перенос в морозилку сам по себе не продлевает срок', () => {
  const original = batch({ minTemp: null, maxTemp: null, requiredStorage: null });
  const moved = transitionBatch(original, { storage: 'freezer' }, now);
  assert.equal(evaluateBatch(original, defaultSettings, now).deadline, evaluateBatch(moved, defaultSettings, now).deadline);
});
test('проверяются невозможные даты, отрицательные количества и будущая дата вскрытия', () => {
  assert.equal(batchInputSchema.safeParse({ ...batch(), labelExpiresOn: '2026-02-30' }).success, false);
  assert.equal(batchInputSchema.safeParse({ ...batch(), quantity: -1 }).success, false);
  assert.equal(batchInputSchema.safeParse({ ...batch(), minTemp: 8, maxTemp: 2 }).success, false);
  assert.throws(() => transitionBatch(batch(), { openedAt: '2026-10-23T09:00:00Z' }, now), /будущем/);
});
