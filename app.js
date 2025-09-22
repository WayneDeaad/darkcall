import { firebaseConfig } from './firebase-config.js';
import { getIceServers } from './ice-provider.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, collection, doc, addDoc, setDoc, getDoc, updateDoc,
  onSnapshot, serverTimestamp, deleteDoc, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

/** ==== helpers & UI ==== */
const persist=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};
const restore=(k,f)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):f}catch{return f}};
const uid=()=>{try{const a=new Uint32Array(2);crypto.getRandomValues(a);return(a[0].toString(36)+a[1].toString(36)).slice(0,8)}catch{return Math.random().toString(36).slice(2,10)}};
const fmtDur=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

const ui={
  statusDot:document.getElementById('statusDot'),statusText:document.getElementById('statusText'),
  precall:document.getElementById('precall'),call:document.getElementById('callScreen'),
  roomInput:document.getElementById('roomIdInput'),createBtn:document.getElementById('createBtn'),joinBtn:document.getElementById('joinBtn'),
  copyBtn:document.getElementById('copyLinkBtn'),linkBox:document.getElementById('linkBox'),roomLink:document.getElementById('roomLink'),
  muteBtn:document.getElementById('muteBtn'),endBtn:document.getElementById('endBtn'),deafenBtn:document.getElementById('deafenBtn'),
  remoteAudio:document.getElementById('remoteAudio'),chat:document.getElementById('chat'),chatToggle:document.getElementById('chatToggle'),
  messages:document.getElementById('messages'),messageInput:document.getElementById('messageInput'),sendBtn:document.getElementById('sendBtn'),
  callTime:document.getElementById('callTime'),pulse:document.getElementById('pulseCircle'),
  openSettingsBtn:document.getElementById('openSettingsBtn'),closeSettingsBtn:document.getElementById('closeSettingsBtn'),settings:document.getElementById('settings'),
  micSelect:document.getElementById('micSelect'),outSelect:document.getElementById('outSelect'),outWrap:document.getElementById('outWrap'),
  micGain:document.getElementById('micGain'),outGain:document.getElementById('outGain'),gate:document.getElementById('gate'),
  modeSelect:document.getElementById('modeSelect'),echo:document.getElementById('echoCancellation'),noise:document.getElementById('noiseSuppression'),
  agc:document.getElementById('autoGainControl'),forceTurn:document.getElementById('forceTurn'),forceTurnSheet:document.getElementById('forceTurnSheet')
};

let app,db,auth;
let pc, role=null, usingRelay=restore('forceRelay',false);
let roomRef, callerCandCol, calleeCandCol, msgUnsub=null;
let callStartTs=0, timerId=null, isMuted=false, isDeaf=false, connectedOnce=false;
let user={id:uid(), name:'User-'+Math.random().toString(36).slice(2,6)};

const state = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  icePolicy: 'all', // 'all' | 'relay'
  watchdog: null,
  lastBytesIn: 0,
  lastBytesTime: 0,
};

function setStatus(stateName,text){ ui.statusText.textContent=text; ui.statusDot.className='dot '+({idle:'dot-idle',connecting:'dot-connecting',connected:'dot-connected',error:'dot-error'}[stateName]||'dot-idle'); }
function toggleSheet(open){ ui.settings.classList.toggle('open',open); }
function setInCall(active){ ui.precall.classList.toggle('hidden',active); ui.call.classList.toggle('hidden',!active);
  ui.muteBtn.disabled=ui.endBtn.disabled=ui.deafenBtn.disabled=ui.messageInput.disabled=ui.sendBtn.disabled=!active;
  ui.chatToggle.setAttribute('aria-expanded', active?'true':'false'); if(active){ ui.chat.classList.remove('hidden'); } }
function roomLinkFromId(id){ const u=new URL(location.href); u.searchParams.set('room',id); return u.toString(); }
function getAudioConstraints(){ return { audio:{ deviceId:undefined, echoCancellation:ui.echo.checked, noiseSuppression:ui.noise.checked, autoGainControl:ui.agc.checked, channelCount:1 }, video:false }; }
function updateTimer(){ if(!callStartTs) return; const s=Math.floor((Date.now()-callStartTs)/1000); ui.callTime.textContent=fmtDur(s); }

/** Simple audio pipeline */
let inputStream=null, destStream=null, micGainNode=null, outGain=restore('outGain',1);
async function buildAudio(){
  if(inputStream){ inputStream.getTracks().forEach(t=>t.stop()); inputStream=null; }
  inputStream=await navigator.mediaDevices.getUserMedia(getAudioConstraints());
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  const src=ctx.createMediaStreamSource(inputStream);
  micGainNode=ctx.createGain(); micGainNode.gain.value=restore('micGain',1);
  const comp=ctx.createDynamicsCompressor();
  const gv=restore('gate',0); comp.threshold.value=-60+gv*50; comp.ratio.value=20;
  destStream=ctx.createMediaStreamDestination();
  src.connect(micGainNode); micGainNode.connect(comp); comp.connect(destStream);
  ui.remoteAudio.volume=outGain;
}

/** ICE & RTC */
function tuneOpus(sdp){
  const m=sdp.split('\r\n'); const idx=m.findIndex(l=>l.startsWith('m=audio')); if(idx===-1) return sdp;
  const rtp=m.filter(l=>l.startsWith('a=rtpmap:')&&l.includes('opus/48000')); if(!rtp.length) return sdp;
  const pt=rtp[0].split(':')[1].split(' ')[0]; const parts=m[idx].split(' '); const head=parts.slice(0,3); const pts=[pt,...parts.slice(3).filter(x=>x!==pt)]; m[idx]=[...head,...pts].join(' ');
  const br =(document.getElementById('modeSelect')?.value==='music')?128000:96000; const dtx=(br===96000)?1:0;
  const fmtpIdx=m.findIndex(l=>l.startsWith('a=fmtp:'+pt)); const f='a=fmtp:'+pt+` minptime=10;useinbandfec=1;stereo=0;maxaveragebitrate=${br};ptime=20;usedtx=${dtx}`;
  if(fmtpIdx===-1){ const rtpIdx=m.findIndex(l=>l.startsWith('a=rtpmap:'+pt)); m.splice(rtpIdx+1,0,f);} else { m[fmtpIdx]=f; }
  return m.join('\r\n');
}

function rtcConfig(){
  return { iceServers: state.iceServers, iceCandidatePoolSize: 10, iceTransportPolicy: state.icePolicy };
}

function createPeer(){
  if(pc){ try{ pc.close(); }catch{} }
  pc=new RTCPeerConnection(rtcConfig());
  pc.ontrack=e=>{ ui.remoteAudio.srcObject=e.streams[0]; };
  pc.onconnectionstatechange=()=>{
    const st=pc.connectionState;
    if(st==='connected'){ onConnected(); }
    else if(st==='connecting'){ setStatus('connecting','Подключение…'); }
    else if(st==='failed'){ // авто‑переключение политики
      if(state.icePolicy==='all'){ forceRelayAndRestart('Сбой: переключаюсь на TURN…'); }
      else { setStatus('error','Сбой соединения'); }
    }
    else if(st==='disconnected'){ setStatus('connecting','Пытаемся восстановить…'); /* дождёмся watchDog */ }
  };
  pc.oniceconnectionstatechange = ()=>{
    const s = pc.iceConnectionState;
    if(s==='failed' && state.icePolicy==='all'){ forceRelayAndRestart('ICE fail → TURN'); }
  };
  return pc;
}

async function forceRelayAndRestart(msg){
  console.log(msg);
  state.icePolicy='relay'; persist('forceRelay',true);
  await restartIce();
}

async function restartIce(){
  if(!pc) return;
  try{
    const sender=pc.getSenders().find(s=>s.track&&s.track.kind==='audio');
    let offer=await pc.createOffer({iceRestart:true, offerToReceiveAudio:true});
    offer.sdp=tuneOpus(offer.sdp);
    await pc.setLocalDescription(offer);
    await updateDoc(roomRef,{ offer:{type:offer.type,sdp:offer.sdp, ts: Date.now()} });
  }catch(e){ console.warn('restartIce', e); }
}

function startWatchdog(){
  stopWatchdog();
  state.watchdog = setInterval(async ()=>{
    if(!pc) return;
    try{
      const stats = await pc.getStats(null);
      let bytesIn = 0;
      stats.forEach(report => {
        if(report.type === 'inbound-rtp' && report.kind === 'audio'){
          bytesIn += report.bytesReceived||0;
        }
      });
      const now = Date.now();
      if(state.lastBytesTime && now - state.lastBytesTime > 6000){
        const delta = bytesIn - state.lastBytesIn;
        if(delta < 500){ // менее ~500 байт за 6с — похоже на зависание
          if(state.icePolicy==='all'){ await forceRelayAndRestart('Нет трафика → TURN'); }
          else { await restartIce(); }
        }
      }
      state.lastBytesIn = bytesIn;
      state.lastBytesTime = now;
    }catch{}
  }, 3000);
}
function stopWatchdog(){ if(state.watchdog){ clearInterval(state.watchdog); state.watchdog=null; } }

function onConnected(){
  setStatus('connected','Подключено');
  if(!connectedOnce){
    connectedOnce=true;
    startCallUI();
  }
  startWatchdog();
}

/** Firestore chat (минимально) */
let msgCol;
function subMessages(){ if(msgUnsub) msgUnsub(); const q=query(msgCol, orderBy('createdAt','asc'), limit(300)); msgUnsub=onSnapshot(q, sn=>{ ui.messages.innerHTML=''; sn.forEach(d=>renderMsg(d.data())); ui.messages.scrollTop=ui.messages.scrollHeight; }); }
async function postSys(kind,extra={}){ try{ await addDoc(msgCol,{type:'system',kind,createdAt:serverTimestamp(),...extra}); }catch{} }
async function sendText(){ const t=ui.messageInput.value.trim(); if(!t) return; ui.messageInput.value=''; try{ await addDoc(msgCol,{type:'text',text:t,from:user.id,name:user.name,createdAt:serverTimestamp()}); }catch{} }
function renderMsg(m){ if(m.type==='system'){ const d=document.createElement('div'); d.className='msg-system'; d.textContent = m.kind==='call_ended' && m.duration ? `Звонок завершён (${fmtDur(m.duration)})` : (m.kind==='call_started'?'Звонок начался':'Система'); ui.messages.appendChild(d); return; } const b=document.createElement('div'); b.className='msg-bubble '+(m.from===user.id?'msg-right':''); b.textContent=m.text; ui.messages.appendChild(b); const meta=document.createElement('div'); meta.className='msg-meta'; meta.textContent=(m.from===user.id?'Ты':'Гость'); ui.messages.appendChild(meta); }

/** flows */
let currentOfferSdp='', currentAnswerSdp='';

async function createRoom(){
  role='caller';
  usingRelay = ui.forceTurn.checked || ui.forceTurnSheet.checked;
  state.icePolicy = usingRelay ? 'relay' : 'all';
  persist('forceRelay', usingRelay);
  setStatus('connecting','Создаём комнату…');

  // ICE из Xirsys
  state.iceServers = await getIceServers();

  await buildAudio(); createPeer();
  const track=destStream.getAudioTracks()[0]; pc.addTrack(track, destStream);

  roomRef = await addDoc(collection(db,'rooms'), { createdAt: serverTimestamp() });
  callerCandCol = collection(roomRef, 'callerCandidates'); calleeCandCol = collection(roomRef, 'calleeCandidates'); msgCol = collection(roomRef,'messages'); subMessages();
  pc.onicecandidate=async(ev)=>{ if(ev.candidate){ await addDoc(callerCandCol, ev.candidate.toJSON()); } };

  let offer=await pc.createOffer({offerToReceiveAudio:true}); offer.sdp=tuneOpus(offer.sdp); await pc.setLocalDescription(offer);
  await setDoc(roomRef,{ offer:{type:offer.type,sdp:offer.sdp, ts: Date.now()} },{merge:true});
  showLink(roomRef.id);

  onSnapshot(roomRef, async (snap)=>{
    const data=snap.data(); const ans=data?.answer;
    if(ans && ans.sdp !== currentAnswerSdp){ currentAnswerSdp=ans.sdp; await pc.setRemoteDescription(new RTCSessionDescription(ans)); }
  });
  onSnapshot(collection(roomRef,'calleeCandidates'), (snap)=>{ snap.docChanges().forEach(async ch=>{ if(ch.type==='added'){ try{ await pc.addIceCandidate(ch.doc.data()); }catch{} } }); });

  // авто‑фоллбек, если долго нет connected
  setTimeout(async ()=>{ if(pc && pc.connectionState!=='connected' && state.icePolicy==='all'){ await forceRelayAndRestart('Таймаут → TURN'); } }, 9000);
}

async function joinByInput(){
  let v=(ui.roomInput.value||'').trim();
  if(!v) return;
  try{ if(v.startsWith('http')){ const u=new URL(v); v=u.searchParams.get('room')||v; } }catch{}
  await joinRoom(v);
}

async function joinRoom(roomId){
  role='callee';
  usingRelay = ui.forceTurn.checked || ui.forceTurnSheet.checked;
  state.icePolicy = usingRelay ? 'relay' : 'all';
  persist('forceRelay', usingRelay);
  setStatus('connecting','Подключаемся…');

  // ICE из Xirsys
  state.iceServers = await getIceServers();

  await buildAudio(); createPeer();
  const track=destStream.getAudioTracks()[0]; pc.addTrack(track, destStream);
  roomRef = doc(db,'rooms',roomId);
  const snap=await getDoc(roomRef); if(!snap.exists()){ setStatus('error','Комната не найдена'); return; }
  calleeCandCol = collection(roomRef,'calleeCandidates'); callerCandCol = collection(roomRef,'callerCandidates'); msgCol = collection(roomRef,'messages'); subMessages();
  pc.onicecandidate=async(ev)=>{ if(ev.candidate){ await addDoc(calleeCandCol, ev.candidate.toJSON()); } };

  onSnapshot(roomRef, async (rsnap)=>{
    const data=rsnap.data(); const off=data?.offer; if(off && off.sdp !== currentOfferSdp){
      currentOfferSdp=off.sdp; await pc.setRemoteDescription(new RTCSessionDescription(off)); let ans=await pc.createAnswer(); ans.sdp=tuneOpus(ans.sdp); await pc.setLocalDescription(ans); await updateDoc(roomRef,{ answer:{type:ans.type,sdp:ans.sdp, ts: Date.now()} });
    }
  });
  onSnapshot(callerCandCol, (snap)=>{ snap.docChanges().forEach(async ch=>{ if(ch.type==='added'){ try{ await pc.addIceCandidate(ch.doc.data()); }catch{} } }); });

  setTimeout(async ()=>{ if(pc && pc.connectionState!=='connected' && state.icePolicy==='all'){ await forceRelayAndRestart('Таймаут → TURN'); } }, 9000);
}

function startCallUI(){ setInCall(true); callStartTs=Date.now(); if(timerId) clearInterval(timerId); timerId=setInterval(updateTimer,1000); updateTimer(); postSys('call_started'); }
function stopCallUI(){ setInCall(false); ui.callTime.textContent=''; if(timerId) clearInterval(timerId); callStartTs=0; connectedOnce=false; ui.chat.classList.add('hidden'); ui.chatToggle.setAttribute('aria-expanded','false'); stopWatchdog(); }

async function hangUp(){
  try{ if(callStartTs){ await postSys('call_ended',{duration:Math.round((Date.now()-callStartTs)/1000)}); } stopCallUI(); setStatus('idle','Звонок завершён'); if(pc){ pc.getSenders().forEach(s=>s.track&&s.track.stop()); pc.close(); } if(roomRef){ try{ await updateDoc(roomRef,{endedAt:serverTimestamp()}); const cols=['callerCandidates','calleeCandidates']; for(const c of cols){ const col=collection(roomRef,c); const sn=await getDocs(col); await Promise.all(sn.docs.map(d=>deleteDoc(d.ref))); } }catch{} } } finally{ pc=null; role=null; }
}

function showLink(id){ ui.linkBox.hidden=false; ui.roomLink.textContent=roomLinkFromId(id); }
async function copyLink(){ const l=ui.roomLink.textContent || roomLinkFromId(ui.roomInput.value.trim()||''); if(!l) return; try{ await navigator.clipboard.writeText(l);}catch{} }

/** devices */
async function prepareDevices(){
  try{ const s=await navigator.mediaDevices.getUserMedia({audio:true,video:false}); s.getTracks().forEach(t=>t.stop()); }catch{}
  const dev=await navigator.mediaDevices.enumerateDevices();
  const mics=dev.filter(d=>d.kind==='audioinput'); const outs=dev.filter(d=>d.kind==='audiooutput');
  ui.micSelect.innerHTML=''; mics.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Микрофон'; ui.micSelect.appendChild(o); });
  if(typeof ui.remoteAudio.setSinkId!=='function'){ ui.outWrap.style.display='none'; } else { ui.outWrap.style.display=''; ui.outSelect.innerHTML=''; outs.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Динамики'; ui.outSelect.appendChild(o); }); }
}

/** init */
let appInit=false;
async function init(){
  if(appInit) return; appInit=true;
  try{ const a=initializeApp(firebaseConfig); app=a; auth=getAuth(a); await signInAnonymously(auth); db=getFirestore(a);}catch(e){ setStatus('error','Firebase не инициализирован'); console.error(e); }
  ui.createBtn.addEventListener('click',createRoom); ui.joinBtn.addEventListener('click',joinByInput); ui.copyBtn.addEventListener('click',copyLink);
  ui.openSettingsBtn.addEventListener('click',()=>toggleSheet(true)); ui.closeSettingsBtn.addEventListener('click',()=>toggleSheet(false));
  ui.sendBtn.addEventListener('click',sendText); ui.messageInput.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); sendText(); }});
  ui.chatToggle.addEventListener('click',()=>{ const h=ui.chat.classList.contains('hidden'); ui.chat.classList.toggle('hidden',!h); ui.chatToggle.setAttribute('aria-expanded', String(h)); });
  ui.muteBtn.addEventListener('click',()=>{ isMuted=!isMuted; if(destStream){ destStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);} ui.muteBtn.setAttribute('aria-pressed',String(isMuted)); });
  ui.deafenBtn.addEventListener('click',()=>{ isDeaf=!isDeaf; ui.remoteAudio.muted=isDeaf; ui.deafenBtn.setAttribute('aria-pressed',String(isDeaf)); });
  ui.endBtn.addEventListener('click',hangUp);
  ui.micGain.addEventListener('input',()=>{ const v=parseFloat(ui.micGain.value); if(micGainNode){ micGainNode.gain.value=v; } persist('micGain',v); });
  ui.outGain.addEventListener('input',()=>{ outGain=parseFloat(ui.outGain.value); ui.remoteAudio.volume=outGain; persist('outGain',outGain); });
  ui.gate.addEventListener('input',()=>{ persist('gate', parseFloat(ui.gate.value)); buildAudio(); if(pc){ const tr=destStream.getAudioTracks()[0]; const s=pc.getSenders().find(s=>s.track&&s.track.kind==='audio'); if(s&&tr) s.replaceTrack(tr); } });
  ui.forceTurn.checked = usingRelay; ui.forceTurnSheet.checked = usingRelay;
  ui.forceTurn.addEventListener('change',()=>{ usingRelay=ui.forceTurn.checked; ui.forceTurnSheet.checked=usingRelay; state.icePolicy=usingRelay?'relay':'all'; persist('forceRelay',usingRelay); });
  ui.forceTurnSheet.addEventListener('change',()=>{ usingRelay=ui.forceTurnSheet.checked; ui.forceTurn.checked=usingRelay; state.icePolicy=usingRelay?'relay':'all'; persist('forceRelay',usingRelay); });

  // auto join by ?room=
  const params=new URLSearchParams(location.search); const room=params.get('room'); await prepareDevices(); await buildAudio();
  if(room){ ui.roomInput.value=room; await joinRoom(room);} else { setStatus('idle','Готов'); }
}
init();
