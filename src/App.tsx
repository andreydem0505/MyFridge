import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DateTime } from 'luxon';
import { Bell, BellRing, CalendarDays, Check, CheckCheck, ChevronRight, Clock3, CookingPot,
  ExternalLink, Flame, Flower2, Leaf, LoaderCircle, Package, PackageCheck, Plus, Refrigerator,
  Search, Settings2, ShieldCheck, Snowflake, Sprout, Trash2, TriangleAlert, UtensilsCrossed, X, Archive,
  ArrowUpRight, CircleHelp, CircleCheck, Minus, Pencil, DoorOpen, DoorClosed, Menu } from 'lucide-react';
import { api, json, enablePush, disablePush, pushEnabled } from './api.js';
import { defaultSettings, statusNames, storageNames, units,
  type BatchInput, type EvaluatedBatch, type Recipe, type Settings, type Snapshot, type Storage } from '../shared/model.js';

type Tab = 'fridge' | 'recipes' | 'reminders' | 'settings';
const pages = { fridge: 'Мой холодильник', recipes: 'Что приготовить', reminders: 'Напоминания', settings: 'Настройки' };
function emoji(name: string) {
  const n = name.toLowerCase();
  for (const [pattern, icon] of [[/молок|кефир|сливки/, '🥛'], [/яй/, '🥚'], [/помидор|томат/, '🍅'], [/карто/, '🥔'],
    [/сыр/, '🧀'], [/сметан|йогурт|творог/, '🥣'], [/огур/, '🥒'], [/морков/, '🥕'], [/лук/, '🧅'], [/чеснок/, '🧄'],
    [/кур|индей|мяс|говяд|свин/, '🍗'], [/рыб|лосос|семг|треск/, '🐟'], [/яблок/, '🍎'], [/банан/, '🍌'],
    [/масло/, '🫙'], [/соль|сахар|мук/, '🧂'], [/рис|греч|круп/, '🌾'], [/капуст|зелень|салат|укроп/, '🥬'],
    [/гриб|шампин/, '🍄'], [/хлеб|батон/, '🍞'], [/ягод|клубник/, '🍓']] as [RegExp, string][]) if (pattern.test(n)) return icon;
  return '🛒';
}
function prettyDate(iso: string, zone: string, time = false) {
  return DateTime.fromISO(iso, { zone }).setLocale('ru').toFormat(time ? 'd MMM, HH:mm' : 'd MMM');
}
function remaining(item: EvaluatedBatch) {
  if (item.status === 'spoiled') return 'Отмечено вручную';
  if (item.status === 'review') return 'Нужно уточнение';
  if (item.remainingHours < 0) return 'Срок истёк';
  if (item.remainingHours < 1) return 'Меньше часа';
  if (item.remainingHours < 24) return `Осталось ${Math.ceil(item.remainingHours)} ч`;
  return `Осталось ${Math.ceil(item.remainingHours / 24)} дн.`;
}
function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} className={`modal ${wide ? 'wide' : ''}`} onCancel={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={21} /></button></header>
    {children}
  </dialog>;
}

function ProductForm({ item, settings, onClose, onSave }: { item?: EvaluatedBatch; settings: Settings; onClose: () => void; onSave: (value: BatchInput) => Promise<void> }) {
  const [form, setForm] = useState<BatchInput>(item ? { ...item } : {
    name: '', quantity: 1, unit: 'шт.', labelExpiresOn: '', packaged: true, isOpen: false, openedAt: null,
    afterOpenHours: null, storage: 'fridge', requiredStorage: 'fridge', afterOpeningStorage: null,
    minTemp: null, maxTemp: null, notes: '',
  });
  const [durationUnit, setDurationUnit] = useState<'hours' | 'days'>('hours');
  const [suggestions, setSuggestions] = useState<{ id: number; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [typing, setTyping] = useState(false);
  const set = <K extends keyof BatchInput>(key: K, value: BatchInput[K]) => setForm(old => ({ ...old, [key]: value }));
  useEffect(() => {
    if (!typing || form.name.length < 2) { setSuggestions([]); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      api<{ products: { id: number; name: string }[] }>(`/products?q=${encodeURIComponent(form.name)}`, { signal: controller.signal })
        .then(v => setSuggestions(v.products)).catch(() => setSuggestions([]));
    }, 350);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [form.name, typing]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setSaving(true);
    try {
      await onSave({ ...form, openedAt: item?.openedAt ?? (form.isOpen ? form.openedAt || new Date().toISOString() : form.openedAt) });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return <Modal title={item ? 'Изменить продукт' : 'Добавить в холодильник'} subtitle="Каждая упаковка хранится отдельно — со своим сроком." onClose={onClose}>
    <form className="product-form" onSubmit={submit}>
      <div className="form-section"><h3><span>01</span> О продукте</h3>
        <div className="field suggestion-field"><label htmlFor="product-name">Название продукта</label>
          <input id="product-name" autoFocus required maxLength={120} placeholder="Например, молоко" value={form.name}
            onChange={e => { set('name', e.target.value); setTyping(true); }} autoComplete="off"
            onBlur={e => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setTyping(false); }} />
          {!!suggestions.length && <div className="suggestions">{suggestions.map(s => <button type="button" key={s.id}
            onClick={() => { set('name', s.name); setTyping(false); setSuggestions([]); }}>{emoji(s.name)} {s.name}</button>)}</div>}
        </div>
        <div className="form-grid"><div className="field"><label htmlFor="quantity">Количество</label><input id="quantity" required type="number" step="any" min="0.001" max="1000000" value={Number.isFinite(form.quantity) ? form.quantity : ''} onChange={e => set('quantity', e.target.valueAsNumber)} /></div>
          <div className="field"><label htmlFor="unit">Единица</label><select id="unit" value={form.unit} onChange={e => set('unit', e.target.value as BatchInput['unit'])}>{units.map(u => <option key={u}>{u}</option>)}</select></div></div>
      </div>
      <div className="form-section"><h3><span>02</span> Сроки и упаковка</h3>
        <div className="field"><label htmlFor="expiry">Годен до — дата на этикетке</label><input id="expiry" type="date" required value={form.labelExpiresOn} onChange={e => set('labelExpiresOn', e.target.value)} /></div>
        <div className="field"><label htmlFor="packaging">Состояние упаковки</label><select id="packaging" value={!form.packaged ? 'none' : form.isOpen ? 'opened' : 'closed'} onChange={e => {
          setForm(v => ({ ...v, packaged: e.target.value !== 'none', isOpen: e.target.value === 'opened',
            openedAt: v.openedAt ?? (e.target.value === 'opened' ? new Date().toISOString() : null) }));
        }}><option value="closed">{form.openedAt ? 'Закрыта после вскрытия' : 'Запечатана'}</option><option value="opened">Вскрыта</option>
          {!item?.openedAt && <option value="none">Без упаковки</option>}</select></div>
        {(form.packaged || form.openedAt) && <>
          <div className="form-grid"><div className="field"><label htmlFor="after-open">Срок после вскрытия</label>
            <input id="after-open" type="number" min="0.01" max={durationUnit === 'days' ? 365 : 8760} step="any" placeholder="По этикетке"
              value={form.afterOpenHours === null ? '' : form.afterOpenHours / (durationUnit === 'days' ? 24 : 1)}
              onChange={e => set('afterOpenHours', e.target.value ? e.target.valueAsNumber * (durationUnit === 'days' ? 24 : 1) : null)} /></div>
            <div className="field"><label htmlFor="duration-unit">Единица срока</label><select id="duration-unit" value={durationUnit} onChange={e => setDurationUnit(e.target.value as 'hours' | 'days')}><option value="hours">Часов</option><option value="days">Дней</option></select></div></div>
          {(form.isOpen || form.openedAt) && <div className="field"><label htmlFor="opened-at">Первое вскрытие</label>
            <input id="opened-at" type="datetime-local" readOnly={!!item?.openedAt}
              value={form.openedAt ? DateTime.fromISO(form.openedAt).setZone(settings.timezone).toFormat("yyyy-MM-dd'T'HH:mm") : ''}
              onChange={e => set('openedAt', DateTime.fromISO(e.target.value, { zone: settings.timezone }).toUTC().toISO())} />
            <small>{item?.openedAt ? 'Закрытие упаковки не сбрасывает эту дату.' : `Время в часовом поясе ${settings.timezone}`}</small></div>}
        </>}
        <div className="note"><Clock3 size={16} /><span>Берём более ранний срок: дату с этикетки или срок после вскрытия. Универсальные сроки не подставляются.</span></div>
      </div>
      <div className="form-section"><h3><span>03</span> Условия хранения</h3>
        <div className="form-grid"><div className="field"><label htmlFor="storage">Где хранится</label><select id="storage" value={form.storage} onChange={e => set('storage', e.target.value as Storage)}>{Object.entries(storageNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></div>
          <div className="field"><label htmlFor="required-storage">Где хранить по этикетке</label><select id="required-storage" value={form.requiredStorage ?? ''} onChange={e => set('requiredStorage', (e.target.value || null) as Storage | null)}><option value="">Не указано</option>{Object.entries(storageNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></div></div>
        {form.packaged && <div className="field"><label htmlFor="opened-storage">Где хранить после вскрытия</label><select id="opened-storage" value={form.afterOpeningStorage ?? ''} onChange={e => set('afterOpeningStorage', (e.target.value || null) as Storage | null)}><option value="">В тех же условиях</option>{Object.entries(storageNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></div>}
        <div className="form-grid"><div className="field"><label htmlFor="min-temp">Температура от, °C</label><input id="min-temp" type="number" min="-80" max="60" step="any" placeholder="Не указана" value={form.minTemp ?? ''} onChange={e => set('minTemp', e.target.value === '' ? null : e.target.valueAsNumber)} /></div>
          <div className="field"><label htmlFor="max-temp">Температура до, °C</label><input id="max-temp" type="number" min="-80" max="60" step="any" placeholder="Не указана" value={form.maxTemp ?? ''} onChange={e => set('maxTemp', e.target.value === '' ? null : e.target.valueAsNumber)} /></div></div>
        <small>В выбранном месте указано {settings.temperatures[form.storage]} °C. Температуры можно изменить в настройках.</small>
        <div className="field"><label htmlFor="notes">Примечание с этикетки</label><textarea id="notes" rows={2} maxLength={1000} placeholder="Условия хранения или другая важная информация" value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}{item ? 'Сохранить изменения' : 'Добавить продукт'}</button></footer>
    </form>
  </Modal>;
}

function ProductDetail({ item, zone, onClose, onEdit, onAction }: { item: EvaluatedBatch; zone: string; onClose: () => void; onEdit: () => void; onAction: (action: string) => Promise<void> }) {
  const [events, setEvents] = useState<{ id: string; kind: string; created_at: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ events: typeof events }>(`/batches/${item.id}/history`).then(v => setEvents(v.events)).catch(() => {}); }, [item.id, item.updatedAt]);
  const names: Record<string, string> = { added: 'Добавлено в холодильник', updated: 'Данные изменены', open: 'Упаковка вскрыта', close: 'Упаковка закрыта — срок сохранён', spoil: 'Отмечено как испорченное', consume: 'Убрано из запасов', 'review-storage': 'Условия проверены', 'storage-changed': 'Изменились условия хранения', demo: 'Добавлен пример' };
  async function act(action: string) { setBusy(true); setError(''); try { await onAction(action); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); } }
  return <Modal title={item.name} subtitle={`${item.quantity} ${item.unit} · ${storageNames[item.storage]}`} onClose={onClose}>
    <div className="detail-content"><div className={`detail-status ${item.status}`}><span className="food-emoji">{emoji(item.name)}</span><div><span className={`status ${item.status}`}>{statusNames[item.status]}</span><h3>{remaining(item)}</h3><p>Расчётный срок: {prettyDate(item.deadline, zone, true)}</p></div></div>
      <dl className="detail-list"><div><dt>Дата на этикетке</dt><dd>{prettyDate(item.labelDeadline, zone, true)}</dd></div>
        <div><dt>Упаковка</dt><dd>{!item.packaged ? 'Без упаковки' : item.isOpen ? 'Вскрыта' : item.openedAt ? 'Закрыта после вскрытия' : 'Запечатана'}</dd></div>
        {item.openedAt && <><div><dt>Первое вскрытие</dt><dd>{prettyDate(item.openedAt, zone, true)}</dd></div><div><dt>После вскрытия</dt><dd>{item.afterOpenHours ? `${item.afterOpenHours} ч` : 'Срок не указан'}</dd></div></>}
        {item.openedDeadline && <div><dt>Срок после вскрытия</dt><dd>{prettyDate(item.openedDeadline, zone, true)}</dd></div>}
        <div><dt>Участвует в подборе</dt><dd>{item.eligible ? 'Да, проверьте количество в рецепте' : 'Нет'}</dd></div></dl>
      {!!item.reviewReasons.length && <div className="warning-box"><TriangleAlert size={18} /><div>{item.reviewReasons.map(reason => <p key={reason}>{reason}</p>)}
        {item.storageConcern && <button className="text-button" disabled={busy} onClick={() => void act('review-storage')}>Я проверил условия хранения <Check size={15} /></button>}</div></div>}
      {item.notes && <p className="product-notes">{item.notes}</p>}
      <div className="detail-actions">
        {item.packaged && !['expired', 'spoiled', 'consumed'].includes(item.status) && <button className="button secondary" disabled={busy} onClick={() => void act(item.isOpen ? 'close' : 'open')}>{item.isOpen ? <DoorClosed size={17} /> : <DoorOpen size={17} />}{item.isOpen ? 'Закрыть упаковку' : item.openedAt ? 'Открыть снова' : 'Вскрыть упаковку'}</button>}
        <button className="button secondary" onClick={onEdit}><Pencil size={17} />Изменить</button>
        {item.status !== 'spoiled' && <button className="button danger-text" disabled={busy} onClick={() => void act('spoil')}><TriangleAlert size={17} />Испорчено</button>}
        <button className="button secondary" disabled={busy} onClick={async () => { if (await act('consume')) onClose(); }}><Archive size={17} />Убрать из запасов</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <h3 className="section-label">История упаковки</h3><div className="timeline">{events.map(event => <div key={event.id}><span className="timeline-dot"/><div><strong>{names[event.kind] ?? 'Изменение'}</strong><small>{prettyDate(event.created_at, zone, true)}</small></div></div>)}</div>
    </div>
  </Modal>;
}

function SettingsForm({ settings, onSave, enabled, onPush }: { settings: Settings; onSave: (s: Settings) => Promise<void>; enabled: boolean; onPush: () => Promise<void> }) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => setForm(settings), [settings]);
  async function submit(e: FormEvent) { e.preventDefault(); setSaving(true); setMessage(''); try { await onSave(form); setMessage('Настройки сохранены'); } catch (e) { setMessage((e as Error).message); } finally { setSaving(false); } }
  return <div className="settings-layout"><form className="panel settings-panel" onSubmit={submit}>
    <h2><BellRing size={21} /> Когда напоминать</h2><p>Мы предупредим заранее, чтобы у продуктов было больше шансов попасть в ужин.</p>
    <div className="field"><label htmlFor="reminder-hours">За сколько часов до окончания срока</label><input id="reminder-hours" type="number" min="1" max="336" required value={form.reminderHours} onChange={e => setForm(v => ({ ...v, reminderHours: e.target.valueAsNumber }))} /></div>
    <h2><Snowflake size={21} /> Температуры хранения</h2><p>Это введённые вами значения, а не показания датчика. Сверяйте их с реальными условиями.</p>
    <div className="temperature-grid">{(Object.keys(storageNames) as Storage[]).map(storage => <div className="field" key={storage}><label htmlFor={`temp-${storage}`}>{storageNames[storage]}, °C</label><input id={`temp-${storage}`} type="number" min="-80" max="60" required step="any" value={form.temperatures[storage]} onChange={e => setForm(v => ({ ...v, temperatures: { ...v.temperatures, [storage]: e.target.valueAsNumber } }))} /></div>)}</div>
    <div className="field"><label htmlFor="timezone">Часовой пояс</label><input id="timezone" required value={form.timezone} onChange={e => setForm(v => ({ ...v, timezone: e.target.value }))} /><small>Например, Europe/Moscow. Дата на этикетке действует до конца дня в этом поясе.</small></div>
    <button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}Сохранить настройки</button>
    {message && <p className="form-message" role="status">{message}</p>}
  </form><aside className="settings-aside"><div className="panel"><span className="square-icon"><Bell size={23}/></span><h2>Напомним, даже если вкладка закрыта</h2><p>Разрешите push-уведомления. Сервер приложения должен работать, а браузер и устройство — поддерживать их доставку.</p><button className={`button ${enabled ? 'secondary' : 'primary'}`} onClick={() => void onPush()}>{enabled ? <CheckCheck size={18}/> : <BellRing size={18}/>}{enabled ? 'Отключить push' : 'Включить уведомления'}</button></div>
    <div className="note"><ShieldCheck size={19}/><span>Сроки и условия берутся с этикетки. Приложение не определяет безопасность продукта по внешнему виду и не продлевает срок при заморозке.</span></div></aside></div>;
}

export default function App() {
  const initial = new URLSearchParams(location.search).get('tab') as Tab;
  const [tab, setTab] = useState<Tab>(Object.hasOwn(pages, initial ?? '') ? initial : 'fridge');
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EvaluatedBatch | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [storageFilter, setStorageFilter] = useState<Storage | 'all'>('all');
  const [searchText, setSearchText] = useState('');
  const [badTab, setBadTab] = useState(false);
  const [soonOnly, setSoonOnly] = useState(false);
  const [push, setPush] = useState(false);
  const [priority, setPriority] = useState<'match' | 'expiry'>('expiry');
  const [language, setLanguage] = useState('ru');
  const [maxMissing, setMaxMissing] = useState(0);
  const [recipes, setRecipes] = useState<{ results: Recipe[]; unrecognized: string[]; excluded: EvaluatedBatch[]; reason?: string } | null>(null);
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [recipeError, setRecipeError] = useState('');
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const availabilityRef = useRef('');
  const notify = useCallback((message: string) => { setToast(message); setTimeout(() => setToast(''), 5000); }, []);
  const refresh = useCallback(async () => { try { setState(await api<Snapshot>('/state')); setError(''); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void refresh(); void pushEnabled().then(setPush); const timer = setInterval(() => void refresh(), 60000);
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); }; }, [refresh]);
  const batches = state?.batches.filter(b => !b.consumedAt) ?? [];
  const availability = batches.filter(b => b.eligible).map(b => `${b.id}:${b.deadline}:${b.quantity}`).sort().join('|');
  useEffect(() => { if (availabilityRef.current !== availability) setRecipes(null); availabilityRef.current = availability; }, [availability]);
  const soon = batches.filter(b => b.status === 'soon');
  const bad = batches.filter(b => b.status === 'expired' || b.status === 'spoiled');
  const review = batches.filter(b => b.status === 'review');
  const reminders = state?.reminders ?? [];
  const unread = reminders.filter(r => !r.readAt).length;
  const zone = state?.settings.timezone ?? defaultSettings.timezone;
  const selectedBatch = batches.find(b => b.id === selected);
  const isDemo = batches.some(b => b.demo);
  function navigate(next: Tab) { setTab(next); setMobileMenu(false); history.replaceState(null, '', next === 'fridge' ? '/' : `/?tab=${next}`); }
  async function change(path: string, body: unknown, method = 'POST') {
    const next = await api<Snapshot>(path, json(method, body)); setState(next); setRecipes(null); return next;
  }
  async function togglePush() { try { if (push) await disablePush(); else await enablePush(); setPush(!push); notify(push ? 'Push-уведомления отключены' : 'Уведомления включены'); } catch (e) { notify((e as Error).message); } }
  async function findRecipes() {
    setRecipeBusy(true); setRecipeError(''); setRecipes(null);
    try { setRecipes(await api('/recipes/search', json('POST', { priority, language, maxMissing }))); }
    catch (e) { setRecipeError((e as Error).message); } finally { setRecipeBusy(false); }
  }
  const filtered = batches.filter(b => badTab ? ['expired', 'spoiled'].includes(b.status) : !['expired', 'spoiled'].includes(b.status))
    .filter(b => storageFilter === 'all' || b.storage === storageFilter)
    .filter(b => !soonOnly || b.status === 'soon')
    .filter(b => b.name.toLocaleLowerCase('ru').includes(searchText.toLocaleLowerCase('ru')))
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  return <div className="app-shell">
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}><a className="brand" href="/" onClick={e => { e.preventDefault(); navigate('fridge'); }}><span className="brand-icon"><Refrigerator size={25}/></span><span>MyFridge<span className="brand-dot">.</span></span></a>
      <span className="sidebar-caption">МЕНЬШЕ ПОТЕРЬ. БОЛЬШЕ ВКУСА.</span>
      <nav aria-label="Основное меню">{([
        ['fridge', Refrigerator, 'Мой холодильник'], ['recipes', UtensilsCrossed, 'Что приготовить'], ['reminders', Bell, 'Напоминания'],
      ] as const).map(([key, Icon, name]) => <button key={key} className={`nav-item ${tab === key ? 'active' : ''}`} onClick={() => navigate(key)}><Icon size={21}/><span>{name}</span>{key === 'reminders' && unread > 0 && <b className="nav-badge">{unread}</b>}</button>)}</nav>
      <div className="sidebar-tip"><span className="tip-plant"><Sprout size={31}/></span><strong>Каждый продукт важен</strong><p>Начните с того, что нужно использовать раньше.</p><button onClick={() => { setPriority('expiry'); navigate('recipes'); }}>Найти идею для ужина <ArrowUpRight size={16}/></button></div>
      <div className="sidebar-bottom"><button className={`nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={20}/><span>Настройки</span></button><div className="local-profile"><span>МД</span><div><strong>Мой дом</strong><small>Личный холодильник</small></div><Leaf size={17}/></div></div>
    </aside>
    <div className="main-wrap"><header className="topbar"><button className="icon-button mobile-toggle" aria-label="Открыть меню" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={22}/></button><div className="breadcrumb">Мой дом <ChevronRight size={14}/><strong>{pages[tab]}</strong></div><div className="topbar-right"><span className="today"><CalendarDays size={16}/>{DateTime.now().setZone(zone).setLocale('ru').toFormat('d MMMM, cccc')}</span><button className="notification-button" aria-label={`Напоминания: ${unread} непрочитанных`} onClick={() => navigate('reminders')}><Bell size={21}/>{unread > 0 && <i/>}</button><span className="avatar">МД</span></div></header>
      <main className="main-content">
        <div className="page-heading"><div><div className="eyebrow"><span/> {tab === 'recipes' ? 'ВДОХНОВЕНИЕ ИЗ ВАШИХ ЗАПАСОВ' : 'НЕМНОГО ЗАБОТЫ КАЖДЫЙ ДЕНЬ'}</div><h1>{pages[tab]}<span className="heading-dot">.</span></h1><p>{tab === 'fridge' ? 'Знайте, что есть дома. Используйте всё вовремя.' : tab === 'recipes' ? 'Соберём идеи из ваших продуктов — и поможем ничего не забыть.' : tab === 'reminders' ? 'Нужные продукты в нужный момент.' : 'Настройте холодильник под свой ритм.'}</p></div>{tab === 'fridge' && <button className="button primary add-button" onClick={() => setAdding(true)}><Plus size={20}/>Добавить продукт</button>}</div>
        {error && <div className="warning-box" role="alert"><TriangleAlert size={20}/><span>{error}</span><button className="text-button" onClick={() => void refresh()}>Повторить</button></div>}
        {!state && !error && <div className="loading-page"><LoaderCircle className="spin" size={28}/><p>Загружаем ваш холодильник…</p></div>}
        {isDemo && <div className="demo-banner"><span><Flower2 size={17}/>Вы смотрите примеры. Даты вымышлены.</span><button onClick={() => void change('/demo', undefined, 'DELETE').catch(e => notify(e.message))}>Убрать примеры <X size={15}/></button></div>}
        {state && tab === 'fridge' && <>
          <div className="stats-grid"><button className="stat-card" onClick={() => { setBadTab(false); setSoonOnly(false); }}><span className="stat-icon green"><Package size={23}/></span><div><span>Всего в запасах</span><strong>{batches.length}<small>упаковок</small></strong></div><ArrowUpRight size={18}/></button>
            <button className={`stat-card amber ${soonOnly ? 'stat-selected' : ''}`} onClick={() => { setBadTab(false); setSoonOnly(!soonOnly); }}><span className="stat-icon amber"><Clock3 size={23}/></span><div><span>Использовать скорее</span><strong>{soon.length}<small>в ближайшие {state.settings.reminderHours} ч</small></strong></div><ArrowUpRight size={18}/></button>
            <button className="stat-card" onClick={() => { setBadTab(true); setSoonOnly(false); }}><span className="stat-icon rose"><TriangleAlert size={23}/></span><div><span>Срок истёк / испорчено</span><strong>{bad.length}<small>исключены из рецептов</small></strong></div><ArrowUpRight size={18}/></button></div>
          {soon.length > 0 && <div className="use-soon-banner"><div className="banner-symbol"><Flame size={26}/></div><div><strong>Самое время приготовить что-нибудь вкусное</strong><p>{soon.slice(0, 3).map(b => b.name).join(', ')}{soon.length > 3 ? ' и другие продукты' : ''} — используйте в первую очередь.</p></div><button onClick={() => { setPriority('expiry'); navigate('recipes'); }}>Подобрать рецепты <ArrowUpRight size={17}/></button></div>}
          {review.length > 0 && <div className="review-note"><CircleHelp size={18}/><span>У {review.length} упаковок нужно уточнить срок или условия хранения. Они временно не участвуют в подборе.</span></div>}
          <section className="panel inventory-panel"><div className="inventory-tabs"><div role="tablist" aria-label="Состояние запасов"><button role="tab" aria-selected={!badTab} className={!badTab ? 'active' : ''} onClick={() => { setBadTab(false); setSoonOnly(false); }}>В моём холодильнике <span>{batches.length - bad.length}</span></button><button role="tab" aria-selected={badTab} className={badTab ? 'active' : ''} onClick={() => { setBadTab(true); setSoonOnly(false); }}>Просрочено и испорчено <span>{bad.length}</span></button></div><span className="sort-hint"><Clock3 size={15}/>Сначала ближайший срок</span></div>
            <div className="inventory-toolbar"><div className="filter-chips">{(['all', 'fridge', 'freezer', 'pantry'] as const).map(key => <button key={key} className={storageFilter === key ? 'selected' : ''} onClick={() => setStorageFilter(key)}>{key === 'all' ? 'Все продукты' : <>{key === 'freezer' ? <Snowflake size={14}/> : key === 'fridge' ? <Refrigerator size={14}/> : <Archive size={14}/>} {storageNames[key]}</>}</button>)}</div><div className="search-input"><Search size={17}/><input aria-label="Найти продукт" value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Найти продукт…"/></div></div>
            {soonOnly && <button className="active-filter" onClick={() => setSoonOnly(false)}>Только те, что скоро закончатся <X size={14}/></button>}
            {filtered.length > 0 ? <div className="table-scroll"><table className="product-table"><thead><tr><th>ПРОДУКТ</th><th>ХРАНЕНИЕ</th><th>УПАКОВКА</th><th>СРОК ГОДНОСТИ</th><th aria-label="Действие"/></tr></thead><tbody>{filtered.map(item => <tr key={item.id} className={item.status === 'soon' ? 'soon-row' : ''}>
              <td><button className="product-title" onClick={() => setSelected(item.id)}><span className="food-icon">{emoji(item.name)}</span><span><strong>{item.name}</strong><small>{item.quantity} {item.unit}{item.demo ? ' · пример' : ''}</small></span></button></td>
              <td><span className="storage-label">{item.storage === 'freezer' ? <Snowflake size={14}/> : item.storage === 'fridge' ? <Refrigerator size={14}/> : <Archive size={14}/>} {storageNames[item.storage]}</span></td>
              <td><span className={`packaging ${item.openedAt ? 'opened' : ''}`}>{!item.packaged ? <Leaf size={14}/> : item.openedAt ? <DoorOpen size={14}/> : <PackageCheck size={14}/>} {!item.packaged ? 'Без упаковки' : item.isOpen ? 'Вскрыта' : item.openedAt ? 'Закрыта после вскрытия' : 'Запечатана'}</span>{item.openedAt && <small className="opening-date">с {prettyDate(item.openedAt, zone)}</small>}</td>
              <td><span className={`status ${item.status}`}>{(item.status === 'soon' || item.status === 'expired') && <span className="status-dot"/>}{remaining(item)}</span><small className="expiry-date">{prettyDate(item.deadline, zone, !!item.openedDeadline)}</small></td>
              <td><button className="icon-button row-action" aria-label={`Открыть ${item.name}`} onClick={() => setSelected(item.id)}><ChevronRight size={19}/></button></td>
            </tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon">{badTab ? <CircleCheck size={36}/> : <Refrigerator size={38}/>}</span><h2>{badTab ? 'Здесь пока ничего нет' : batches.length ? 'Ничего не найдено' : 'Давайте наполним холодильник'}</h2><p>{badTab ? 'Продукты с истёкшим сроком и отмеченные испорченными появятся здесь.' : batches.length ? 'Попробуйте изменить фильтры или название.' : 'Добавьте первую упаковку — мы запомним сроки и поможем использовать её вовремя.'}</p>{!batches.length && !badTab && <div><button className="button primary" onClick={() => setAdding(true)}><Plus size={18}/>Добавить продукт</button><button className="text-button" onClick={() => void change('/demo', {}).catch(e => notify(e.message))}>Посмотреть на примере <ArrowUpRight size={16}/></button></div>}</div>}
            <footer className="table-footer"><span><ShieldCheck size={15}/>Сроки рассчитываются по введённым данным</span><span>{filtered.length} упаковок</span></footer>
          </section><div className="bottom-tip"><Leaf size={17}/><span>Маленькая привычка, большая польза: сначала используйте продукты с ближайшим сроком.</span></div>
        </>}
        {state && tab === 'recipes' && <>
          <div className="recipe-hero"><div><span className="eyebrow">УЖИН УЖЕ ЕСТЬ В ВАШЕМ ХОЛОДИЛЬНИКЕ</span><h2>Больше идей.<br/><span>Меньше забытых продуктов.</span></h2><p>В подборе участвуют {batches.filter(b => b.eligible).length} упаковок с действующим сроком и подтверждёнными условиями.</p></div><div className="hero-foods" aria-hidden="true"><span>🥗</span><i>🥔</i><b>🍅</b></div></div>
          <div className="panel recipe-controls"><div><label className="section-label">ЧТО ВАЖНЕЕ СЕЙЧАС</label><div className="segmented"><button className={priority === 'expiry' ? 'selected' : ''} onClick={() => { setPriority('expiry'); setRecipes(null); }}><Clock3 size={17}/>Использовать скорее</button><button className={priority === 'match' ? 'selected' : ''} onClick={() => { setPriority('match'); setRecipes(null); }}><UtensilsCrossed size={17}/>Больше совпадений</button></div></div>
            <div className="recipe-options"><label>Ингредиенты<select value={maxMissing} onChange={e => { setMaxMissing(Number(e.target.value)); setRecipes(null); }}><option value={0}>Только из моих продуктов</option><option value={2}>Можно докупить до 2 продуктов</option></select></label><label>Язык рецептов<select value={language} onChange={e => { setLanguage(e.target.value); setRecipes(null); }}><option value="ru">Русский</option><option value="all">Все языки</option><option value="en">Английский</option></select></label><button className="button primary" disabled={recipeBusy || !batches.some(b => b.eligible)} onClick={() => void findRecipes()}>{recipeBusy ? <LoaderCircle className="spin" size={18}/> : <CookingPot size={19}/>}Подобрать рецепты</button></div>
            <p className="control-caption">{priority === 'expiry' ? 'Выше — рецепты, которые используют обязательные ингредиенты с самым близким сроком. Для одинаковых продуктов выбирается самая ранняя упаковка.' : 'Выше — рецепты с меньшим числом недостающих ингредиентов и большим числом совпадений.'}</p></div>
          {(bad.length + review.length > 0) && <div className="review-note"><ShieldCheck size={18}/><span>{bad.length + review.length} упаковок исключены: истёк срок, отмечена порча или нужно уточнить условия.</span></div>}
          {recipeError && <div className="warning-box" role="alert"><TriangleAlert size={18}/>{recipeError}</div>}
          {recipeBusy && <div className="recipe-loading"><LoaderCircle className="spin" size={30}/><h3>Ищем идеи в большой книге рецептов…</h3><p>Приоритет — ваши продукты и их сроки.</p></div>}
          {recipes && <><div className="results-heading"><h2>{recipes.results.length ? 'Идеи для вашего стола' : 'Пока не нашли подходящий рецепт'}</h2><span>{recipes.results.length} рецептов</span></div>
            {!!recipes.unrecognized.length && <div className="review-note"><CircleHelp size={17}/><span>Не удалось сопоставить: {recipes.unrecognized.join(', ')}. Уточните названия в карточках продуктов.</span></div>}
            {!recipes.results.length && <div className="empty-state panel"><CookingPot size={36}/><p>{recipes.reason ?? 'Добавьте продукты или разрешите докупить до двух ингредиентов.'}</p></div>}
            <div className="recipe-grid">{recipes.results.map((recipe, index) => <article className="recipe-card" key={recipe.id}><div className={`recipe-art art-${index % 4}`} aria-hidden="true"><span>{/салат|salad/i.test(recipe.title) ? '🥗' : /суп|soup/i.test(recipe.title) ? '🍲' : /омлет|яич|egg/i.test(recipe.title) ? '🍳' : /карто|драник|potato/i.test(recipe.title) ? '🥔' : '🍽️'}</span><div className="art-leaf"><Leaf size={28}/></div></div><div className="recipe-card-body"><span className={`recipe-label ${recipe.missing_count ? 'needs' : ''}`}>{recipe.missing_count ? `Докупить: ${recipe.missing_count}` : 'Есть все продукты по названию'}</span><h3>{recipe.title}</h3>{recipe.useFirst[0] && <p className="use-first"><Clock3 size={15}/><span>Сначала используйте: <strong>{recipe.useFirst[0].name}</strong><br/>{prettyDate(recipe.useFirst[0].deadline, zone, true)}</span></p>}<button className="text-button" onClick={() => setSelectedRecipe(recipe)}>Посмотреть рецепт <ArrowUpRight size={17}/></button></div></article>)}</div>
            <p className="source-note">Рецепты из RuRecipes-93k и RecipeNLG. Проверьте количества и полный список в исходном рецепте. Английские тексты не переведены.</p></>}
          {!recipes && !recipeBusy && <div className="recipe-start"><span><Sprout size={34}/></span><h2>Начнём с того, что уже есть</h2><p>Выберите приоритет и нажмите «Подобрать рецепты».</p></div>}
        </>}
        {state && tab === 'reminders' && <><div className="reminders-intro panel"><span className="square-icon"><BellRing size={26}/></span><div><h2>Ничего важного не потеряется</h2><p>Напоминаем за {state.settings.reminderHours} ч до окончания срока. Проверка выполняется каждую минуту, пока работает сервер.</p></div><button className={`button ${push ? 'secondary' : 'primary'}`} onClick={() => void togglePush()}>{push ? <CheckCheck size={18}/> : <Bell size={18}/>}{push ? 'Уведомления включены' : 'Включить уведомления'}</button></div>
          <div className="results-heading"><h2>Ваши напоминания <span className="count-pill">{unread}</span></h2>{unread > 0 && <button className="text-button" onClick={() => void change('/reminders/all/read', {}).catch(e => notify(e.message))}><CheckCheck size={17}/>Прочитать все</button>}</div>
          <div className="reminder-list">{reminders.map(reminder => <article className={`panel reminder-card ${reminder.readAt ? 'read' : ''}`} key={reminder.id}><span className={`reminder-symbol ${reminder.kind}`}>{reminder.kind === 'soon' ? <Clock3 size={23}/> : <TriangleAlert size={23}/>}</span><div><div className="reminder-title"><h3>{reminder.name}</h3>{!reminder.readAt && <span className="unread-dot"/>}<small>{prettyDate(reminder.createdAt, zone, true)}</small></div><p>{reminder.message}</p><button className="text-button" onClick={() => setSelected(reminder.batchId)}>Открыть карточку <ChevronRight size={15}/></button></div>{!reminder.readAt && <button className="icon-button" aria-label={`Прочитано: ${reminder.name}`} onClick={() => void change(`/reminders/${reminder.id}/read`, {}).catch(e => notify(e.message))}><Check size={19}/></button>}</article>)}</div>
          {!reminders.length && <div className="empty-state panel"><span className="empty-icon"><Bell size={35}/></span><h2>Пока всё спокойно</h2><p>Когда подойдёт срок или потребуется уточнение, напоминание появится здесь.</p></div>}
        </>}
        {state && tab === 'settings' && <SettingsForm settings={state.settings} enabled={push} onPush={togglePush} onSave={async s => { await change('/settings', s, 'PUT'); }}/>}
      </main><footer className="app-footer"><span><Leaf size={14}/>С заботой о продуктах и вашем времени</span><span>MyFridge · меньше пищевых отходов</span></footer>
    </div>
    {(adding || editing) && state && <ProductForm key={editing?.id ?? 'new'} item={editing} settings={state.settings}
      onClose={() => { setAdding(false); setEditing(undefined); }} onSave={async value => { await change(editing ? `/batches/${editing.id}` : '/batches', value, editing ? 'PUT' : 'POST'); notify(editing ? 'Изменения сохранены' : 'Продукт добавлен'); }}/>}
    {selectedBatch && !editing && <ProductDetail item={selectedBatch} zone={zone} onClose={() => setSelected(null)} onEdit={() => setEditing(selectedBatch)} onAction={async action => { await change(`/batches/${selectedBatch.id}/action`, { action }); notify(action === 'open' ? 'Вскрытие записано, срок пересчитан' : action === 'close' ? 'Упаковка закрыта. Срок отсчитывается с первого вскрытия.' : 'Состояние обновлено'); }}/>}
    {selectedRecipe && <Modal title={selectedRecipe.title} subtitle="Сверьте количества и состояние продуктов перед приготовлением." wide onClose={() => setSelectedRecipe(null)}><div className="recipe-detail"><div className="note"><Clock3 size={18}/><span>Используйте раньше: {selectedRecipe.useFirst.slice(0, 4).map(x => x.name).join(', ')}.</span></div>{selectedRecipe.missing_count > 0 && <div className="warning-box"><TriangleAlert size={18}/><span>Нужно докупить: {selectedRecipe.missing.map(x => x.alternatives.map(a => a.name).join(' или ')).join(', ')}</span></div>}<h3>Ингредиенты</h3><ul className="ingredient-list">{selectedRecipe.ingredients.map((ingredient, i) => <li key={i}>{ingredient}</li>)}</ul><h3>Как приготовить</h3><ol className="instructions">{selectedRecipe.instructions.map((step, i) => <li key={i}>{step.replace(/\\[nr]/g, '\n')}</li>)}</ol><a className="button secondary" href={selectedRecipe.source_url} rel="noreferrer" target="_blank"><ExternalLink size={17}/>Открыть исходный рецепт</a><p className="source-note">Источник: {selectedRecipe.dataset}. Сроки и остатки в рецепте не списываются автоматически.</p></div></Modal>}
    {toast && <div className="toast" role="status"><CircleCheck size={20}/><span>{toast}</span><button className="icon-button" aria-label="Закрыть сообщение" onClick={() => setToast('')}><X size={16}/></button></div>}
  </div>;
}
