import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { evaluateBatch, type Reminder } from '../shared/model.js';
import type { Store } from './database.js';

export function collectReminders(store: Store, now = new Date()) {
  const settings = store.settings();
  let created = 0;
  for (const batch of store.list()) {
    const item = evaluateBatch(batch, settings, now);
    if (item.status === 'fresh' || item.status === 'consumed') continue;
    const kind = item.status === 'review' ? 'review' : item.status;
    const messages = {
      soon: `${batch.name}: срок скоро закончится. Используйте в первую очередь.`,
      expired: `${batch.name}: указанный срок истёк. Продукт исключён из подбора рецептов.`,
      review: `${batch.name}: уточните срок после вскрытия или условия хранения.`,
      spoiled: `${batch.name}: отмечен как испорченный и исключён из рецептов.`,
    };
    const reminder: Reminder = { id: randomUUID(), batchId: batch.id, name: batch.name, kind,
      message: messages[kind], createdAt: now.toISOString(), readAt: null, deadline: item.deadline };
    // Reading a reminder must not recreate it every minute.
    const key = `${batch.id}:${kind}:${item.deadline}:${kind === 'review' ? item.reviewReasons.join('|') : ''}`;
    created += Number(store.createReminder(reminder, key));
  }
  return created;
}
export function setupPush(store: Store) {
  let keys = store.getSetting<{ publicKey: string; privateKey: string } | null>('vapid', null);
  if (!keys) { keys = webpush.generateVAPIDKeys(); store.putSetting('vapid', keys); }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'https://example.com/myfridge', keys.publicKey, keys.privateKey);
  return keys.publicKey;
}
export async function deliverPush(store: Store) {
  const subscriptions = store.db.prepare('SELECT endpoint,payload FROM subscriptions').all();
  if (!subscriptions.length) return;
  for (const reminder of store.pendingPush()) {
    const current = store.get(reminder.batchId);
    if (!current || current.consumedAt) continue;
    // Do not deliver an obsolete expiry reminder after a corrected label or state.
    const evaluated = evaluateBatch(current, store.settings());
    if (evaluated.deadline !== reminder.deadline || evaluated.status !== reminder.kind) {
      store.db.prepare('UPDATE reminders SET delivered=1 WHERE id=?').run(reminder.id); continue;
    }
    let retry = false;
    for (const row of subscriptions) {
      try {
        await webpush.sendNotification(JSON.parse(String(row.payload)), JSON.stringify({
          id: reminder.id, title: 'MyFridge · ваши продукты', body: reminder.message, url: '/?tab=reminders',
        }), { TTL: 3600, timeout: 10000 });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) store.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(String(row.endpoint));
        else retry = true;
      }
    }
    if (!retry) store.db.prepare('UPDATE reminders SET delivered=1 WHERE id=?').run(reminder.id);
  }
}
