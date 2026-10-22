import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { Store } from '../server/database.js';
import { collectReminders } from '../server/notifications.js';

async function fixture(run: (context: { store: Store; request: (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>; advance: (hours: number) => void; calls: any[] }) => Promise<void>) {
  const store = new Store(':memory:');
  let instant = new Date('2026-10-22T09:00:00Z');
  const calls: unknown[] = [];
  const app = createApp(store, { now: () => instant, bridge: async request => { calls.push(request); return { results: [], unrecognized: [] }; } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ store, request, calls, advance: hours => { instant = new Date(instant.getTime() + hours * 3600000); } }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}
const input = { name: 'Молоко', quantity: 1, unit: 'л', labelExpiresOn: '2026-10-28', storage: 'fridge', requiredStorage: 'fridge', minTemp: 2, maxTemp: 6, afterOpenHours: 36 };

test('каждая упаковка хранится отдельно; открытие пересчитывает срок, закрытие его сохраняет', async () => fixture(async ({ request, advance }) => {
  const first = await request('/batches', 'POST', input);
  const id = first.body.batches[0].id;
  const second = await request('/batches', 'POST', input);
  assert.equal(second.body.batches.length, 2); assert.notEqual(second.body.batches[0].id, id);
  const opened = await request(`/batches/${id}/action`, 'POST', { action: 'open' });
  const product = opened.body.batches.find((x: any) => x.id === id);
  assert.equal(product.deadline, '2026-10-23T21:00:00.000Z');
  advance(12);
  const closed = await request(`/batches/${id}/action`, 'POST', { action: 'close' });
  assert.equal(closed.body.batches.find((x: any) => x.id === id).deadline, product.deadline);
}));
test('нарушение температуры запоминается до явной проверки условий', async () => fixture(async ({ request }) => {
  const added = await request('/batches', 'POST', input); const id = added.body.batches[0].id;
  const settings = added.body.settings;
  const warm = await request('/settings', 'PUT', { ...settings, temperatures: { ...settings.temperatures, fridge: 12 } });
  assert.equal(warm.body.batches[0].eligible, false);
  assert.equal((await request(`/batches/${id}/action`, 'POST', { action: 'review-storage' })).status, 400);
  const cold = await request('/settings', 'PUT', settings);
  assert.equal(cold.body.batches[0].status, 'review');
  const reviewed = await request(`/batches/${id}/action`, 'POST', { action: 'review-storage' });
  assert.equal(reviewed.body.batches[0].eligible, true);
}));
test('напоминания сохраняются, не дублируются и сменяются при просрочке', async () => fixture(async ({ request, advance, store }) => {
  const added = await request('/batches', 'POST', { ...input, isOpen: true, afterOpenHours: 4 });
  const id = added.body.batches[0].id;
  assert.equal(added.body.reminders.length, 1); assert.equal(added.body.reminders[0].kind, 'soon');
  await request('/reminders/all/read', 'POST', {});
  const repeated = await request('/state');
  assert.equal(repeated.body.reminders.length, 1); assert.ok(repeated.body.reminders[0].readAt);
  advance(5);
  const expired = await request('/state');
  assert.equal(expired.body.batches[0].eligible, false);
  assert.equal(expired.body.reminders.length, 1); assert.equal(expired.body.reminders[0].kind, 'expired');
  assert.equal(collectReminders(store, new Date('2026-10-22T14:00:00Z')), 0);
  const consumed = await request(`/batches/${id}/action`, 'POST', { action: 'consume' });
  assert.equal(consumed.body.reminders.length, 0);
}));
test('подбор получает только доступные партии и выбранный приоритет', async () => fixture(async ({ request, calls }) => {
  await request('/batches', 'POST', input);
  await request('/batches', 'POST', { ...input, name: 'Яйца', labelExpiresOn: '2026-10-21' });
  await request('/batches', 'POST', { ...input, name: 'Сметана', isOpen: true, afterOpenHours: null });
  const bad = await request('/batches', 'POST', { ...input, name: 'Сыр' });
  const id = bad.body.batches[0].id;
  await request(`/batches/${id}/action`, 'POST', { action: 'spoil' });
  const result = await request('/recipes/search', 'POST', { priority: 'expiry', maxMissing: 0, language: 'ru' });
  assert.equal(result.status, 200); assert.equal(result.body.excluded.length, 3);
  assert.equal(calls.at(-1).priority, 'expiry');
  assert.deepEqual(calls.at(-1).inventory.map((x: any) => x.name), ['Молоко']);
}));
test('невалидные данные, сторонние origin и произвольные push-адреса отклоняются', async () => fixture(async ({ request }) => {
  assert.equal((await request('/batches', 'POST', { ...input, quantity: 0 })).status, 400);
  assert.equal((await request('/batches', 'POST', input, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/push/subscribe', 'POST', { endpoint: 'https://attacker.invalid/push', keys: { auth: 'a'.repeat(20), p256dh: 'b'.repeat(100) } })).status, 400);
  const state = await request('/state'); assert.equal(JSON.stringify(state.body).includes('privateKey'), false);
}));
