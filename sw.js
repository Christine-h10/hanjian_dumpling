const VERSION='hejian-v1',CORE=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==VERSION).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const url=new URL(r.url);
  if(r.mode==='navigate'){ // network first, fall back to cached page when offline
    e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(VERSION).then(c=>c.put('./index.html',cp));return res}).catch(()=>caches.match('./index.html')));return}
  if(url.hostname.includes('google.com')||url.hostname.includes('calendar.app'))return; // maps / booking: always live
  // everything else (own files, CDN scripts, fonts, images): stale-while-revalidate
  e.respondWith(caches.open(VERSION).then(c=>c.match(r).then(hit=>{
    const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==='opaque'))c.put(r,res.clone());return res}).catch(()=>hit);
    return hit||net})));
});
