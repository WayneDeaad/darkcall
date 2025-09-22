import { xirsys } from './xirsys-config.js';

const LS_KEY = 'cachedIceServersV2';

/** Прямой запрос к Xirsys — как в твоём cURL. Сначала пробуем его, чтобы не ловить 500 от функций. */
async function fetchDirect(channel){
  const url = `https://${encodeURIComponent(xirsys.user)}:${encodeURIComponent(xirsys.secret)}@global.xirsys.net/_turn/${encodeURIComponent(channel || xirsys.channel)}`;
  const res = await fetch(url, {
    method:'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'urls' })
  });
  if(!res.ok) throw new Error('Xirsys direct failed: ' + res.status);
  const data = await res.json();
  return (data?.v?.iceServers || data?.iceServers || []);
}

/** Netlify Function — более безопасно, но не всегда настроено (может дать 500). */
async function fetchViaNetlify(channel){
  const url = '/.netlify/functions/xirsys-ice?channel=' + encodeURIComponent(channel || xirsys.channel);
  const res = await fetch(url, { method:'GET' });
  if(!res.ok) throw new Error('Netlify ICE failed: ' + res.status);
  const data = await res.json();
  return (Array.isArray(data) ? data : (data?.v?.iceServers || data?.iceServers || []));
}

export async function getIceServers(){
  // 1) Пытаемся прямой Xirsys (как cURL)
  try{
    const s1 = await fetchDirect();
    localStorage.setItem(LS_KEY, JSON.stringify(s1));
    return s1;
  }catch(e1){
    console.warn('Xirsys direct failed', e1);
  }
  // 2) Пробуем Netlify Function
  try{
    const s2 = await fetchViaNetlify();
    localStorage.setItem(LS_KEY, JSON.stringify(s2));
    return s2;
  }catch(e2){
    console.warn('Netlify ICE failed', e2);
  }
  // 3) Кэш
  try{
    const cached = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    if(cached.length) return cached;
  }catch{}
  // 4) Фоллбек на STUN
  return [{ urls: ['stun:stun.l.google.com:19302'] }];
}
