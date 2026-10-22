self.addEventListener('push', event => {
  let message = { title: 'MyFridge', body: 'Проверьте сроки годности продуктов.', url: '/?tab=reminders' };
  try { message = { ...message, ...event.data.json() }; } catch { /* Empty payload uses the default message. */ }
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body, icon: '/icon.svg', badge: '/icon.svg', tag: message.id || 'myfridge',
    data: { url: message.url },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin);
    if (target.origin !== self.location.origin) return;
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).origin === target.origin) { await client.navigate(target.href); return client.focus(); }
    }
    return self.clients.openWindow(target.href);
  })());
});
