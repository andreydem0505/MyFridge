import 'dotenv/config';
import { Store } from './database.js';
import { createApp } from './app.js';
import { collectReminders, deliverPush } from './notifications.js';
const store = new Store(process.env.INVENTORY_DB ?? 'data/fridge.sqlite');
const app = createApp(store);
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3001);
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { collectReminders(store); await deliverPush(store); }
  catch (error) { console.error('Не удалось проверить напоминания:', error instanceof Error ? error.message : error); }
  finally { ticking = false; }
}
const server = app.listen(port, host, () => { console.log(`MyFridge API: http://${host}:${port}`); void tick(); });
const timer = setInterval(() => void tick(), 60000);
function stop() { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
