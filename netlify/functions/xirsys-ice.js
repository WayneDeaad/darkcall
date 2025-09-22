// Netlify Function: безопасный прокси к Xirsys.
// Переименуйте файл, если нужно: netlify/functions/xirsys-ice.js
// В Netlify добавьте переменные окружения (Site settings → Environment):
//  XIRSYS_USER=DevDemon
//  XIRSYS_SECRET=66d34f1a-97a5-11f0-a5dc-0242ac130002
//  XIRSYS_CHANNEL=MyFirstApp
// Если переменные не заданы — используем зашитые значения (небезопасно).

export async function handler(event, context) {
  const user = process.env.XIRSYS_USER || "DevDemon";
  const secret = process.env.XIRSYS_SECRET || "66d34f1a-97a5-11f0-a5dc-0242ac130002";
  const channel = (event.queryStringParameters && event.queryStringParameters.channel) || process.env.XIRSYS_CHANNEL || "MyFirstApp";
  const url = `https://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@global.xirsys.net/_turn/${encodeURIComponent(channel)}`;
  try{
    const resp = await fetch(url, { method:'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ format:'urls' }) });
    const data = await resp.json();
    // Возвращаем только iceServers
    const iceServers = (data && (data.v?.iceServers || data.iceServers)) || [];
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify(iceServers)
    };
  }catch(e){
    return { statusCode: 500, headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: String(e) }) };
  }
}
