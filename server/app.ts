import express from 'express';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { batchInputSchema, settingsSchema, evaluateBatch, storageIssues, transitionBatch, type Batch } from '../shared/model.js';
import { Store } from './database.js';
import { collectReminders, setupPush } from './notifications.js';
import { recipeBridge } from './recipes.js';

export function createApp(store: Store, options: { now?: () => Date; bridge?: typeof recipeBridge } = {}) {
  const app = express();
  const now = options.now ?? (() => new Date());
  const bridge = options.bridge ?? recipeBridge;
  const publicKey = setupPush(store);
  let searching = false;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    // This is a private, single-household app. Reject cross-site writes.
    const origin = req.get('origin');
    if (origin && !['GET', 'HEAD'].includes(req.method)) {
      const allowed = [process.env.APP_ORIGIN, `http://${req.get('host')}`, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'].filter(Boolean);
      if (!allowed.includes(origin)) { res.status(403).json({ error: 'Запрос с другого сайта отклонён' }); return; }
    }
    next();
  });
  const snapshot = () => {
    collectReminders(store, now());
    const settings = store.settings();
    const batches = store.list().map(b => evaluateBatch(b, settings, now()));
    const active = new Map(batches.filter(b => !b.consumedAt).map(b => [b.id, b]));
    const reminders = store.reminders().filter(r => {
      const batch = active.get(r.batchId);
      return batch && batch.status === r.kind && batch.deadline === r.deadline;
    });
    return { batches, settings, reminders, now: now().toISOString() };
  };
  app.get('/api/state', (_req, res) => res.json(snapshot()));
  app.post('/api/batches', (req, res) => {
    const input = batchInputSchema.parse(req.body);
    const instant = now();
    if (input.openedAt && new Date(input.openedAt) > instant) throw new Error('Дата вскрытия не может быть в будущем');
    if (!input.packaged && input.isOpen) throw new Error('Для продукта без упаковки не указывайте вскрытие');
    const batch: Batch = { ...input, openedAt: input.openedAt ?? (input.isOpen ? instant.toISOString() : null),
      id: randomUUID(), createdAt: instant.toISOString(), updatedAt: instant.toISOString(), spoiledAt: null,
      consumedAt: null, storageConcern: null, demo: false };
    batch.storageConcern = storageIssues(batch, store.settings())[0] ?? null;
    store.save(batch, 'added', instant.toISOString());
    res.status(201).json(snapshot());
  });
  app.put('/api/batches/:id', (req, res) => {
    const previous = store.get(String(req.params.id));
    if (!previous) { res.status(404).json({ error: 'Продукт не найден' }); return; }
    if (previous.consumedAt) throw new Error('Эта упаковка уже убрана из запасов');
    const input = batchInputSchema.parse(req.body);
    const updated = transitionBatch(previous, input, now());
    updated.storageConcern = previous.storageConcern ?? storageIssues(updated, store.settings())[0] ?? null;
    store.save(updated, 'updated', now().toISOString());
    res.json(snapshot());
  });
  app.post('/api/batches/:id/action', (req, res) => {
    const action = z.enum(['open', 'close', 'spoil', 'consume', 'review-storage']).parse(req.body.action);
    const previous = store.get(String(req.params.id));
    if (!previous) { res.status(404).json({ error: 'Продукт не найден' }); return; }
    if (previous.consumedAt) throw new Error('Продукт уже убран из запасов');
    let batch = { ...previous, updatedAt: now().toISOString() };
    if (action === 'open' || action === 'close') batch = transitionBatch(previous, { isOpen: action === 'open' }, now());
    if (action === 'spoil') batch.spoiledAt = now().toISOString();
    if (action === 'consume') batch.consumedAt = now().toISOString();
    if (action === 'review-storage') {
      if (storageIssues(batch, store.settings()).length) throw new Error('Сначала исправьте условия хранения в карточке или настройках');
      batch.storageConcern = null;
    } else batch.storageConcern = previous.storageConcern ?? storageIssues(batch, store.settings())[0] ?? null;
    store.save(batch, action, now().toISOString());
    res.json(snapshot());
  });
  app.get('/api/batches/:id/history', (req, res) => res.json({ events: store.history(String(req.params.id)) }));
  app.put('/api/settings', (req, res) => {
    const settings = settingsSchema.parse(req.body);
    store.putSetting('preferences', settings);
    for (const batch of store.list().filter(b => !b.consumedAt && !b.storageConcern)) {
      const concern = storageIssues(batch, settings)[0];
      if (concern) store.save({ ...batch, storageConcern: concern, updatedAt: now().toISOString() }, 'storage-changed', now().toISOString());
    }
    res.json(snapshot());
  });
  app.post('/api/reminders/:id/read', (req, res) => { store.markRead(String(req.params.id), now().toISOString()); res.json(snapshot()); });
  app.get('/api/push/key', (_req, res) => res.json({ publicKey }));
  const subscriptionSchema = z.object({ endpoint: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/.test(url.hostname);
  }, 'Неизвестный сервис уведомлений'), expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(20).max(500), auth: z.string().min(10).max(100) }) });
  app.post('/api/push/subscribe', (req, res) => {
    const subscription = subscriptionSchema.parse(req.body);
    store.db.prepare('INSERT INTO subscriptions VALUES (?,?) ON CONFLICT(endpoint) DO UPDATE SET payload=excluded.payload')
      .run(subscription.endpoint, JSON.stringify(subscription));
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = z.string().max(3000).parse(req.body.endpoint);
    store.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint);
    res.json({ ok: true });
  });
  app.get('/api/products', async (req, res) => res.json(await bridge({ op: 'suggest', query: String(req.query.q ?? '').slice(0, 100) })));
  app.post('/api/recipes/search', async (req, res) => {
    const input = z.object({ priority: z.enum(['expiry', 'match']), language: z.enum(['ru', 'en', 'all']).default('ru'),
      maxMissing: z.number().int().min(0).max(5).default(0) }).parse(req.body);
    if (searching) { res.status(429).json({ error: 'Подбор уже идёт. Подождите несколько секунд.' }); return; }
    const evaluated = store.list().map(b => evaluateBatch(b, store.settings(), now()));
    const eligible = evaluated.filter(b => b.eligible);
    const excluded = evaluated.filter(b => !b.eligible && !b.consumedAt);
    if (!eligible.length) { res.json({ results: [], unrecognized: [], excluded, reason: 'Добавьте продукты с действующим сроком и подтверждёнными условиями' }); return; }
    searching = true;
    try { res.json({ ...await bridge({ ...input, op: 'search', inventory: eligible.map(b => ({ id: b.id, name: b.name, deadline: b.deadline })) }), excluded }); }
    finally { searching = false; }
  });
  app.post('/api/demo', (_req, res) => {
    if (store.list().some(b => b.demo)) { res.json(snapshot()); return; }
    const today = DateTime.fromJSDate(now()).setZone(store.settings().timezone);
    const examples = [
      { name: 'Молоко', quantity: 0.7, unit: 'л', days: 5, opened: true, hours: 36, emoji: '🥛' },
      { name: 'Помидоры', quantity: 4, unit: 'шт.', days: 1, packaged: false },
      { name: 'Яйца', quantity: 6, unit: 'шт.', days: 8 },
      { name: 'Картофель', quantity: 1.5, unit: 'кг', days: 6, packaged: false },
      { name: 'Сыр твёрдый', quantity: 200, unit: 'г', days: 4 },
      { name: 'Сметана', quantity: 150, unit: 'г', days: -1 },
      { name: 'Лук', quantity: 2, unit: 'шт.', days: 7, packaged: false },
      { name: 'Соль', quantity: 500, unit: 'г', days: 300, storage: 'pantry' },
      { name: 'Растительное масло', quantity: 0.5, unit: 'л', days: 100, storage: 'pantry' },
    ];
    for (const item of examples) {
      const b = item as typeof item & { opened?: boolean; hours?: number; packaged?: boolean; storage?: 'pantry' };
      const input = batchInputSchema.parse({ name: b.name, quantity: b.quantity, unit: b.unit,
        labelExpiresOn: today.plus({ days: b.days }).toISODate(), packaged: b.packaged !== false,
        isOpen: !!b.opened, openedAt: b.opened ? today.minus({ hours: 12 }).toUTC().toISO() : null,
        afterOpenHours: b.hours ?? null, storage: b.storage ?? 'fridge', requiredStorage: b.storage ?? 'fridge',
        notes: 'Демонстрационная запись. Сроки вымышлены и не являются рекомендацией по хранению.' });
      store.save({ ...input, id: randomUUID(), createdAt: now().toISOString(), updatedAt: now().toISOString(),
        spoiledAt: null, consumedAt: null, storageConcern: null, demo: true }, 'demo', now().toISOString());
    }
    res.json(snapshot());
  });
  app.delete('/api/demo', (_req, res) => { store.clearDemo(); res.json(snapshot()); });
  if (existsSync(resolve('dist/index.html'))) {
    app.use(express.static(resolve('dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof ZodError ? error.issues.map(x => x.message).join('. ')
      : error instanceof Error ? error.message : 'Не удалось выполнить действие';
    res.status(400).json({ error: message });
  });
  return app;
}
