const CACHE_NAME = "word-study-app-shell-v6-4-flow";
const PATCH_URL = "./flow-patch.js?v=6.4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./spell-dictionary.js",
  "./manifest.webmanifest",
  PATCH_URL
];


self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of CORE_ASSETS) {
        try {
          await cache.add(url);
        } catch (error) {
          console.warn("キャッシュを省略:", url, error);
        }
      }
    })
  );
  self.skipWaiting();
});


self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});


async function addPatchScript(response) {
  if (!response) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;


  let html = await response.text();
  if (!html.includes("flow-patch.js")) {
    const tag = `<script src="${PATCH_URL}" defer></script>`;
    html = html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : `${html}${tag}`;
  }


  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}


self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;


  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;


  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request, { cache: "no-store" });
        const patchedResponse = await addPatchScript(networkResponse);
        const copy = patchedResponse.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put("./index.html", copy);
        return patchedResponse;
      } catch (error) {
        const cached = await caches.match("./index.html") || await caches.match("./");
        return cached || Response.error();
      }
    })());
    return;
  }


  event.respondWith((async () => {
    const cached = await caches.match(request);
    try {
      const networkResponse = await fetch(request);
      if (networkResponse.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      return cached || Response.error();
    }
  })());
});


self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./#today", self.location.href).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(targetUrl) : undefined;
    })
  );
});