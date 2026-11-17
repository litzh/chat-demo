/* Cache only the app shell. API responses, attachments and provider traffic are never cached. */
const CACHE = 'dsh-shell-v1'
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      const response = await fetch('/')
      const html = await response.clone().text()
      const assets = [...html.matchAll(/(?:src|href)="([^"]*static[/][^"]+\.(?:js|css))"/g)]
        .map((match) => new URL(match[1], self.location.origin).href)
        .filter((url) => new URL(url).origin === self.location.origin)
      await cache.put('/', response)
      await cache.addAll(['/manifest.webmanifest', '/icon.svg', '/icon-512.png', ...assets])
    })
  )
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('dsh-shell-') && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
  )
})
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put('/', clone)))
          }
          return response
        })
        .catch(() => caches.match('/'))
    )
  } else if (
    url.pathname.startsWith('/static/') ||
    ['/icon.svg', '/icon-512.png', '/manifest.webmanifest'].includes(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone()
              event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, clone)))
            }
            return response
          })
      )
    )
  }
})
