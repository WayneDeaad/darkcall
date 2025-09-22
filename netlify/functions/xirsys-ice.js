// Netlify Function: прокси к Xirsys через Basic Auth.
export async function handler(event, context) {
  const user = process.env.XIRSYS_USER || "DevDemon";
  const secret = process.env.XIRSYS_SECRET || "66d34f1a-97a5-11f0-a5dc-0242ac130002";
  const channel = (event.queryStringParameters && event.queryStringParameters.channel) || process.env.XIRSYS_CHANNEL || "MyFirstApp";
  const url = `https://global.xirsys.net/_turn/${encodeURIComponent(channel)}`;
  const auth = 'Basic ' + Buffer.from(`${user}:${secret}`).toString('base64');
  try{
    const resp = await fetch(url, {
      method:'PUT',
      headers: { 'Authorization': auth, 'Content-Type':'application/json' },
      body: JSON.stringify({ format:'urls' })
    });
    const text = await resp.text();
    const status = resp.status;
    if(status < 200 || status >= 300){
      return { statusCode: status, headers: {"access-control-allow-origin":"*"}, body: JSON.stringify({ error: 'Xirsys error', status, body: text }) };
    }
    const data = JSON.parse(text);
    const iceServers = (data && (data.v?.iceServers || data.iceServers)) || [];
    return { statusCode: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(iceServers) };
  }catch(e){
    return { statusCode: 500, headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: String(e) }) };
  }
}
