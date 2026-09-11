const CACHE='wrapsheet-shell-v6';
const FILES=['./','./index.html','./install.js','./style.css','./app.js','./db.js','./model.js','./receipt.js','./invoice.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./vendor/html2pdf.bundle.min.js','./vendor/NotoSansKR.ttf','./example-template.html'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
// A new worker waits until old tabs close; no mid-session mixed-version replacement.
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('wrapsheet-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).catch(error=>{if(event.request.mode==='navigate')return caches.match('./index.html','./install.js');throw error;})));});
