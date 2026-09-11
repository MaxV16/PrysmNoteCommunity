/* Prysm Note service worker - handles browser Web Push notifications. */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "Prysm Note", body: "" };
  try {
    const payload = event.data ? event.data.json() : {};
    data = { ...data, ...payload };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  const options = {
    body: data.body,
    icon: "/prysm-icon.svg",
    badge: "/prysm-icon.svg",
    tag: "prysm-notification",
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          return;
        }
      }
      return self.clients.openWindow("/");
    })
  );
});
