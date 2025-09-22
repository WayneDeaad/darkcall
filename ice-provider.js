import { xirsys } from './xirsys-config.js';

const LS_KEY = 'cachedIceServers_V4';

function sanitize(list){
  try{
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    const norm = arr.map(item => {
      if(!item) return null;
      const urls = item.urls || item.url || item.uris || item.uri;
      const u = Array.isArray(urls) ? urls : (urls ? [urls] : []);
      const o = { urls: u };
      if(item.username) o.username = item.username;
      if(item.credential) o.credential = item.credential;
      return o;
    }).filter(Boolean);
    return norm.length ? norm : [{ urls: ['stun:stun.l.google.com:19302'] }];
  }catch{
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
}

/** Прямой запрос к Xirsys с Basic Auth */
async function fetchDirect(channel){
  const res = await fetch('https://global.xirsys.net/_turn/' + encodeURIComponent(channel || xirsys.channel), {
    method: 'PUT',
    headers: {
      'Authorization': 'Basic ' + btoa(`${xirsys.user}:${xirsys.secret}`),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ format: 'urls' })
  });
  if(!res.ok) throw new Error('Xirsys direct failed: ' + res.status);
  const data = await res.json();
  const raw = (data?.v?.iceServers || data?.iceServers || []);
  return sanitize(raw);
}

/** Netlify Function — безопасно; если настроены env */
async function fetchViaNetlify(channel){
  const res = await fetch('/.netlify/functions/xirsys-ice?channel=' + encodeURIComponent(channel || xirsys.channel), { method:'GET' });
  if(!res.ok) throw new Error('Netlify ICE failed: ' + res.status);
  const data = await res.json();
  const raw = Array.isArray(data) ? data : (data?.v?.iceServers || data?.iceServers || []);
  return sanitize(raw);
}

export async function getIceServers(){
  // 1) Прямой Xirsys
  try{
    const s1 = await fetchDirect();
    localStorage.setItem(LS_KEY, JSON.stringify(s1));
    return s1;
  }catch(e1){ console.warn('Xirsys direct failed', e1); }
  // 2) Netlify Function
  try{
    const s2 = await fetchViaNetlify();
    localStorage.setItem(LS_KEY, JSON.stringify(s2));
    return s2;
  }catch(e2){ console.warn('Netlify ICE failed', e2); }
  // 3) Кэш
  try{
    const cached = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    if(Array.isArray(cached) && cached.length) return cached;
  }catch{}
  // 4) Фоллбек
  return [{ urls: ['stun:stun.l.google.com:19302'] }];
}
