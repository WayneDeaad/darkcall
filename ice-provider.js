import { xirsys } from './xirsys-config.js';

const LS_KEY = 'cachedIceServersV1';

/** Попытка получить ICE список из Netlify Function (безопаснее). */
async function fetchViaNetlify(channel){
  const url = '/.netlify/functions/xirsys-ice?channel=' + encodeURIComponent(channel || xirsys.channel);
  const res = await fetch(url, { method:'GET' });
  if(!res.ok) throw new Error('Netlify ICE failed');
  const data = await res.json();
  if(Array.isArray(data)) return data;
  if(data?.v?.iceServers) return data.v.iceServers;
  if(data?.iceServers) return data.iceServers;
  throw new Error('Bad ICE payload');
}

/** Прямой вызов Xirsys (просто, но ключи видны в браузере + может быть CORS). */
async function fetchDirect(channel){
  const url = `https://${encodeURIComponent(xirsys.user)}:${encodeURIComponent(xirsys.secret)}@global.xirsys.net/_turn/${encodeURIComponent(channel || xirsys.channel)}`;
  const res = await fetch(url, {
    method:'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'urls' })
  });
  if(!res.ok) throw new Error('Xirsys direct failed');
  const data = await res.json();
  if(data?.v?.iceServers) return data.v.iceServers;
  if(data?.iceServers) return data.iceServers;
  throw new Error('Bad ICE payload');
}

export async function getIceServers(){
  // 1) Пробуем Netlify function
  try{
    const s1 = await fetchViaNetlify();
    localStorage.setItem(LS_KEY, JSON.stringify(s1));
    return s1;
  }catch{}

  // 2) Пробуем прямой REST Xirsys (может упасть из‑за CORS)
  try{
    const s2 = await fetchDirect();
    localStorage.setItem(LS_KEY, JSON.stringify(s2));
    return s2;
  }catch{}

  // 3) Фоллбек — кэш, если есть
  try{
    const cached = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    if(cached.length) return cached;
  }catch{}

  // 4) Минимальный STUN (совсем фоллбек)
  return [{ urls: ['stun:stun.l.google.com:19302'] }];
}
