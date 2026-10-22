import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';

export const storageNames = { fridge: 'Холодильник', freezer: 'Морозилка', pantry: 'Шкаф' } as const;
export type Storage = keyof typeof storageNames;
export const units = ['шт.', 'г', 'кг', 'мл', 'л'] as const;
const zone = z.enum(['fridge', 'freezer', 'pantry']);
const timestamp = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => DateTime.fromISO(s).isValid, 'Проверьте дату');
export const batchInputSchema = z.object({
  name: z.string().trim().min(1, 'Укажите продукт').max(120),
  quantity: z.number().finite().positive('Количество должно быть больше нуля').max(1000000),
  unit: z.enum(units), labelExpiresOn: date,
  packaged: z.boolean().default(true), isOpen: z.boolean().default(false),
  openedAt: timestamp.nullable().default(null),
  afterOpenHours: z.number().finite().positive().max(8760).nullable().default(null),
  storage: zone, requiredStorage: zone.nullable().default(null),
  afterOpeningStorage: zone.nullable().default(null),
  minTemp: z.number().finite().min(-80).max(60).nullable().default(null),
  maxTemp: z.number().finite().min(-80).max(60).nullable().default(null),
  notes: z.string().max(1000).default(''),
}).refine(v => v.minTemp === null || v.maxTemp === null || v.minTemp <= v.maxTemp,
  { message: 'Минимальная температура не может быть выше максимальной', path: ['minTemp'] });
export type BatchInput = z.infer<typeof batchInputSchema>;
export type Batch = BatchInput & {
  id: string; createdAt: string; updatedAt: string; spoiledAt: string | null;
  consumedAt: string | null; storageConcern: string | null; demo: boolean;
};
export const settingsSchema = z.object({
  reminderHours: z.number().int().min(1).max(336),
  timezone: z.string().refine(s => IANAZone.isValidZone(s), 'Неизвестный часовой пояс'),
  temperatures: z.object({ fridge: z.number().finite().min(-40).max(50),
    freezer: z.number().finite().min(-80).max(50), pantry: z.number().finite().min(-40).max(60) }),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  reminderHours: 48, timezone: 'Europe/Moscow', temperatures: { fridge: 4, freezer: -18, pantry: 20 },
};
export type ProductStatus = 'fresh' | 'soon' | 'expired' | 'spoiled' | 'review' | 'consumed';
export const statusNames: Record<ProductStatus, string> = {
  fresh: 'В сроке', soon: 'Использовать скорее', expired: 'Срок истёк',
  spoiled: 'Испорчено', review: 'Уточните условия', consumed: 'Использовано',
};
export interface EvaluatedBatch extends Batch {
  deadline: string; labelDeadline: string; openedDeadline: string | null;
  status: ProductStatus; remainingHours: number; reviewReasons: string[]; eligible: boolean;
}
export function storageIssues(batch: BatchInput, settings: Settings): string[] {
  const expected = batch.openedAt ? batch.afterOpeningStorage ?? batch.requiredStorage : batch.requiredStorage;
  const issues: string[] = [];
  if (expected && batch.storage !== expected) issues.push(`По этикетке требуется: ${storageNames[expected].toLowerCase()}`);
  const temp = settings.temperatures[batch.storage];
  if (batch.minTemp !== null && temp < batch.minTemp) issues.push(`Температура ${temp} °C ниже указанной на этикетке (${batch.minTemp} °C)`);
  if (batch.maxTemp !== null && temp > batch.maxTemp) issues.push(`Температура ${temp} °C выше указанной на этикетке (${batch.maxTemp} °C)`);
  return issues;
}
export function evaluateBatch(batch: Batch, settings: Settings, now = new Date()): EvaluatedBatch {
  const label = DateTime.fromISO(batch.labelExpiresOn, { zone: settings.timezone }).endOf('day');
  const opened = batch.openedAt && batch.afterOpenHours !== null
    ? DateTime.fromISO(batch.openedAt).plus({ hours: batch.afterOpenHours }) : null;
  const deadlineMs = Math.min(label.toMillis(), opened?.toMillis() ?? Infinity);
  const remainingHours = (deadlineMs - now.getTime()) / 3600000;
  const reviewReasons = storageIssues(batch, settings);
  if (batch.storageConcern && !reviewReasons.includes(batch.storageConcern)) reviewReasons.push(batch.storageConcern);
  if (batch.openedAt && batch.afterOpenHours === null) reviewReasons.push('Укажите срок хранения после вскрытия с этикетки');
  let status: ProductStatus = 'fresh';
  if (remainingHours <= settings.reminderHours) status = 'soon';
  if (reviewReasons.length) status = 'review';
  if (remainingHours < 0) status = 'expired';
  if (batch.spoiledAt) status = 'spoiled';
  if (batch.consumedAt) status = 'consumed';
  return { ...batch, deadline: new Date(deadlineMs).toISOString(), labelDeadline: label.toUTC().toISO()!,
    openedDeadline: opened?.toUTC().toISO() ?? null, remainingHours, status, reviewReasons,
    eligible: !batch.consumedAt && !batch.spoiledAt && remainingHours >= 0 && !reviewReasons.length };
}
export function transitionBatch(previous: Batch, changes: Partial<BatchInput>, now: Date): Batch {
  if (previous.openedAt && changes.openedAt === null) throw new Error('Первое вскрытие уже записано: закрытие упаковки не обнуляет срок');
  const input = batchInputSchema.parse({ ...previous, ...changes });
  if (input.openedAt && new Date(input.openedAt).getTime() > now.getTime()) throw new Error('Дата вскрытия не может быть в будущем');
  if (input.isOpen && !input.packaged) throw new Error('У продукта без упаковки нет состояния вскрытия');
  return { ...previous, ...input, openedAt: previous.openedAt ?? input.openedAt ?? (input.isOpen ? now.toISOString() : null),
    updatedAt: now.toISOString() };
}
export interface Reminder {
  id: string; batchId: string; name: string; kind: 'soon' | 'expired' | 'review' | 'spoiled';
  message: string; createdAt: string; readAt: string | null; deadline: string;
}
export interface ProductMatch { original: string; alternatives: { id: number; name: string }[]; matched_product_ids: number[] }
export interface Recipe {
  id: number; title: string; language: string; source_url: string; dataset: string;
  ingredients: string[]; instructions: string[]; missing_count: number; missing: ProductMatch[];
  useFirst: { batchId: string; name: string; deadline: string }[]; earliestDeadline: string | null;
}
export interface Snapshot { batches: EvaluatedBatch[]; settings: Settings; reminders: Reminder[]; now: string }
