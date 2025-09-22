import { xirsys } from './xirsys-config.js';

const LS_KEY = 'cachedIceServersV3';

/** Прямой запрос к Xirsys с заголовком Authorization: Basic ... */
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
  return (data?.v?.iceServers || data?.iceServers || []);
}

/** Netlify Function — безопаснее; если настроишь env, ключи не светятся. */
async function fetchViaNetlify(channel){
  const res = await fetch('/.netlify/functions/xirsys-ice?channel=' + encodeURIComponent(channel || xirsys.channel), { method:'GET' });
  if(!res.ok) throw new Error('Netlify ICE failed: ' + res.status);
  const data = await res.json();
  return (Array.isArray(data) ? data : (data?.v?.iceServers || data?.iceServers || []));
}

export async function getIceServers(){
  // 1) Прямой запрос (как твой пример)
  try{
    const s1 = await fetchDirect();
    localStorage.setItem(LS_KEY, JSON.stringify(s1));
    return s1;
  }catch(e1){
    console.warn('Xirsys direct failed', e1);
  }
  // 2) Netlify Function
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
  // 4) STUN
  return [{ urls: ['stun:stun.l.google.com:19302'] }];
}
