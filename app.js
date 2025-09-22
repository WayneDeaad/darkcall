import { firebaseConfig } from './firebase-config.js';
import { getIceServers } from './ice-provider.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, collection, doc, addDoc, setDoc, getDoc, updateDoc,
  onSnapshot, serverTimestamp, deleteDoc, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

/** ==== helpers & UI ==== */
const qs = (s)=>document.querySelector(s);
const persist=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};
const restore=(k,f)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):f}catch{return f}};
const uid=()=>{try{const a=new Uint32Array(2);crypto.getRandomValues(a);return(a[0].toString(36)+a[1].toString(36)).slice(0,8)}catch{return Math.random().toString(36).slice(2,10)}};
const fmtDur=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
function showToast(msg, ms=2000){ const t=qs('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), ms); }
function setError(msg){ const eb=qs('#errorBox'); if(!msg){ eb.hidden=true; eb.textContent=''; return; } eb.hidden=false; eb.textContent=msg; }
function setStatus(text){ qs('#statusText').textContent=text; }

const ui={
  precall:qs('#precall'), call:qs('#callScreen'),
  roomInput:qs('#roomIdInput'),
  createBtn:qs('#createBtn'), joinBtn:qs('#joinBtn'), copyBtn:qs('#copyLinkBtn'),
  linkBox:qs('#linkBox'), roomLink:qs('#roomLink'),
  chat:qs('#chat'), chatToggle:qs('#chatToggle'),
  messages:qs('#messages'), messageInput:qs('#messageInput'), sendBtn:qs('#sendBtn'),
  muteBtn:qs('#muteBtn'), endBtn:qs('#endBtn'), deafenBtn:qs('#deafenBtn'),
  remoteAudio:qs('#remoteAudio'), callTime:qs('#callTime'), pulse:qs('#pulseCircle'),
  openSettingsBtn:qs('#openSettingsBtn'), closeSettingsBtn:qs('#closeSettingsBtn'), settings:qs('#settings'),
  micSelect:qs('#micSelect'), outSelect:qs('#outSelect'), outWrap:qs('#outWrap'),
  micGain:qs('#micGain'), outGain:qs('#outGain'), gate:qs('#gate'),
  modeSelect:qs('#modeSelect'), echo:qs('#echoCancellation'), noise:qs('#noiseSuppression'), agc:qs('#autoGainControl'),
  forceTurn:qs('#forceTurn'), forceTurnSheet:qs('#forceTurnSheet')
};

let app,db,auth;
let pc, role=null;
let roomRef, callerCandCol, calleeCandCol, msgUnsub=null, roomUnsub=null, callerIceUnsub=null, calleeIceUnsub=null;
let callStartTs=0, timerId=null, isMuted=false, isDeaf=false, connectedOnce=false;
let creating=false, joining=false;

const state = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  icePolicy: restore('forceRelay', false) ? 'relay' : 'all', // 'all' | 'relay'
  watchdog: null,
  lastBytesIn: 0,
  lastBytesTime: 0,
};

function toggleSheet(open){ ui.settings.classList.toggle('open',open); }
function setInCall(active){ ui.precall.classList.toggle('hidden',active); ui.call.classList.toggle('hidden',!active);
  ui.muteBtn.disabled=ui.endBtn.disabled=ui.deafenBtn.disabled=ui.messageInput.disabled=ui.sendBtn.disabled=!active;
  ui.chatToggle.setAttribute('aria-expanded', active?'true':'false'); if(active){ ui.chat.classList.remove('hidden'); } }
function roomLinkFromId(id){ const u=new URL(location.href); u.searchParams.set('room',id); return u.toString(); }
function updateTimer(){ if(!callStartTs) return; const s=Math.floor((Date.now()-callStartTs)/1000); ui.callTime.textContent=fmtDur(s); }

/** Simple audio pipeline */
let inputStream=null, destNode=null, outGain=restore('outGain',1);
function outStream(){ return destNode?.stream; }
async function buildAudio(){
  if(inputStream){ inputStream.getTracks().forEach(t=>t.stop()); inputStream=null; }
  inputStream=await navigator.mediaDevices.getUserMedia({
    audio:{ deviceId:undefined, echoCancellation:ui.echo.checked, noiseSuppression:ui.noise.checked, autoGainControl:ui.agc.checked, channelCount:1 },
    video:false
  });
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  const src=ctx.createMediaStreamSource(inputStream);
  const micGainNode=ctx.createGain(); micGainNode.gain.value=restore('micGain',1);
  const comp=ctx.createDynamicsCompressor(); const gv=restore('gate',0); comp.threshold.value=-60+gv*50; comp.ratio.value=20;
  destNode=ctx.createMediaStreamDestination();
  src.connect(micGainNode); micGainNode.connect(comp); comp.connect(destNode);
  ui.remoteAudio.volume=outGain;

  // Level pulse
  const analyser=ctx.createAnalyser(); analyser.fftSize=512; comp.connect(analyser);
  const data=new Uint8Array(analyser.frequencyBinCount);
  const circle=ui.pulse;
  setInterval(()=>{ analyser.getByteTimeDomainData(data); let sum=0; for(let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum+=v*v; } const rms=Math.sqrt(sum/data.length); const scale=1+Math.min(.15,rms*.9); circle.style.transform=`scale(${scale.toFixed(3)})`; },60);
}

/** ICE & RTC */
function rtcConfig(){
  // защита: iceServers строго массив, иначе дефолт
  const servers = Array.isArray(state.iceServers) ? state.iceServers : [{ urls: ['stun:stun.l.google.com:19302'] }];
  return { iceServers: servers, iceCandidatePoolSize:10, iceTransportPolicy: state.icePolicy };
}

function cleanupSubs(){
  try{ roomUnsub && roomUnsub(); }catch{} roomUnsub=null;
  try{ callerIceUnsub && callerIceUnsub(); }catch{} callerIceUnsub=null;
  try{ calleeIceUnsub && calleeIceUnsub(); }catch{} calleeIceUnsub=null;
  try{ msgUnsub && msgUnsub(); }catch{} msgUnsub=null;
}

function createPeer(){
  try{
    if(pc){ try{ pc.close(); }catch{} }
    pc=new RTCPeerConnection(rtcConfig());
  }catch(e){
    console.error('RTCPeerConnection init error', e);
    showToast('Ошибка инициализации WebRTC'); setError('Проверь ICE‑список. Мы поставили дефолтный STUN.');
    // fallback: дефолт и ещё раз
    state.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    pc=new RTCPeerConnection(rtcConfig());
  }
  pc.ontrack=e=>{ ui.remoteAudio.srcObject=e.streams[0]; };
  pc.onconnectionstatechange=()=>{
    const st=pc.connectionState;
    if(st==='connected'){ onConnected(); }
    else if(st==='connecting'){ setStatus('Подключение…'); }
    else if(st==='failed'){ if(state.icePolicy==='all'){ forceRelayAndRestart('Сбой: переключаюсь на TURN…'); } else { setStatus('Сбой соединения'); } }
    else if(st==='disconnected'){ setStatus('Пытаемся восстановить…'); /* watchdog */ }
  };
  pc.oniceconnectionstatechange=()=>{
    if(pc.iceConnectionState==='failed' && state.icePolicy==='all'){ forceRelayAndRestart('ICE fail → TURN'); }
  };
  return pc;
}

async function forceRelayAndRestart(msg){
  console.log(msg); showToast('Переключаемся на TURN…');
  state.icePolicy='relay'; persist('forceRelay',true);
  await restartIce();
}

async function restartIce(){
  if(!pc) return;
  try{
    const offer=await pc.createOffer({iceRestart:true, offerToReceiveAudio:true});
    await pc.setLocalDescription({ type: offer.type, sdp: tuneOpus(offer.sdp) });
    await updateDoc(roomRef,{ offer:{type:offer.type,sdp:offer.sdp, ts: Date.now()} });
  }catch(e){ console.warn('restartIce', e); }
}

function startWatchdog(){
  stopWatchdog();
  state.watchdog = setInterval(async ()=>{
    if(!pc) return;
    try{
      const stats = await pc.getStats(null);
      let bytesIn=0;
      stats.forEach(r=>{ if(r.type==='inbound-rtp' && r.kind==='audio'){ bytesIn += r.bytesReceived||0; } });
      const now=Date.now();
      if(state.lastBytesTime && now - state.lastBytesTime > 6000){
        const delta = bytesIn - state.lastBytesIn;
        if(delta < 500){
          if(state.icePolicy==='all'){ await forceRelayAndRestart('Нет трафика → TURN'); }
          else { await restartIce(); }
        }
      }
      state.lastBytesIn=bytesIn; state.lastBytesTime=now;
    }catch{}
  }, 3000);
}
function stopWatchdog(){ if(state.watchdog){ clearInterval(state.watchdog); state.watchdog=null; } }

function tuneOpus(sdp){
  try{
    const m=sdp.split('\r\n'); const idx=m.findIndex(l=>l.startsWith('m=audio')); if(idx===-1) return sdp;
    const rtp=m.filter(l=>l.startsWith('a=rtpmap:')&&l.includes('opus/48000')); if(!rtp.length) return sdp;
    const pt=rtp[0].split(':')[1].split(' ')[0]; const parts=m[idx].split(' '); const head=parts.slice(0,3); const pts=[pt,...parts.slice(3).filter(x=>x!==pt)]; m[idx]=[...head,...pts].join(' ');
    const br =(ui.modeSelect?.value==='music')?128000:96000; const dtx=(br===96000)?1:0;
    const fmtpIdx=m.findIndex(l=>l.startsWith('a=fmtp:'+pt)); const f='a=fmtp:'+pt+` minptime=10;useinbandfec=1;stereo=0;maxaveragebitrate=${br};ptime=20;usedtx=${dtx}`;
    if(fmtpIdx===-1){ const rtpIdx=m.findIndex(l=>l.startsWith('a=rtpmap:'+pt)); m.splice(rtpIdx+1,0,f);} else { m[fmtpIdx]=f; }
    return m.join('\r\n');
  }catch{ return sdp; }
}

function onConnected(){
  setStatus('Подключено');
  if(!connectedOnce){ connectedOnce=true; startCallUI(); }
  startWatchdog();
}

/** Chat */
let msgCol;
function subMessages(){
  try{ msgUnsub && msgUnsub(); }catch{};
  const q=query(msgCol, orderBy('createdAt','asc'), limit(300));
  msgUnsub=onSnapshot(q, sn=>{
    ui.messages.innerHTML='';
    sn.forEach(d=>renderMsg(d.data()));
    ui.messages.scrollTop=ui.messages.scrollHeight;
  });
}
async function postSys(kind,extra={}){ try{ await addDoc(msgCol,{type:'system',kind,createdAt:serverTimestamp(),...extra}); }catch{} }
async function sendText(){ const t=ui.messageInput.value.trim(); if(!t) return; ui.messageInput.value=''; try{ await addDoc(msgCol,{type:'text',text:t,from:'me',createdAt:serverTimestamp()}); }catch{} }
function renderMsg(m){
  if(m.type==='system'){
    const d=document.createElement('div'); d.className='msg-system';
    d.textContent = m.kind==='call_ended' && m.duration ? `Звонок завершён (${fmtDur(m.duration)})` : (m.kind==='call_started'?'Звонок начался':'Система');
    ui.messages.appendChild(d); return;
  }
  const b=document.createElement('div'); b.className='msg-bubble '+(m.from==='me'?'msg-right':'');
  b.textContent = m.text; ui.messages.appendChild(b);
  const meta=document.createElement('div'); meta.className='msg-meta'; meta.textContent=(m.from==='me'?'Ты':'Гость'); ui.messages.appendChild(meta);
}

/** Flows */
let currentOfferSdp='', currentAnswerSdp='';

async function createRoom(){
  if(creating) return; creating=true; ui.createBtn.disabled=true; ui.joinBtn.disabled=true; setError('');
  try{
    const force = ui.forceTurn.checked || ui.forceTurnSheet?.checked; state.icePolicy = force ? 'relay' : 'all'; persist('forceRelay', force);
    setStatus('Получаем ICE…');
    state.iceServers = await getIceServers();
    if(!Array.isArray(state.iceServers)) state.iceServers=[{ urls:['stun:stun.l.google.com:19302'] }];

    setStatus('Доступ к микрофону…');
    await buildAudio();
    createPeer();

    const track=outStream().getAudioTracks()[0];
    pc.addTrack(track, outStream());

    setStatus('Создаём комнату…');
    roomRef = await addDoc(collection(db,'rooms'), { createdAt: serverTimestamp() });
    callerCandCol = collection(roomRef, 'callerCandidates'); calleeCandCol = collection(roomRef, 'calleeCandidates'); msgCol = collection(roomRef,'messages'); subMessages();
    pc.onicecandidate=async(ev)=>{ if(ev.candidate){ await addDoc(callerCandCol, ev.candidate.toJSON()); } };

    let offer=await pc.createOffer({offerToReceiveAudio:true}); offer.sdp=tuneOpus(offer.sdp); await pc.setLocalDescription(offer);
    await setDoc(roomRef,{ offer:{type:offer.type,sdp:offer.sdp, ts: Date.now()} },{merge:true});
    showLink(roomRef.id);

    roomUnsub = onSnapshot(roomRef, async (snap)=>{
      const data=snap.data(); const ans=data?.answer;
      if(ans && ans.sdp !== currentAnswerSdp && pc.signalingState === 'have-local-offer' && !pc.currentRemoteDescription){
        currentAnswerSdp=ans.sdp; await pc.setRemoteDescription(new RTCSessionDescription(ans));
      }
    });
    calleeIceUnsub = onSnapshot(collection(roomRef,'calleeCandidates'), (snap)=>{
      snap.docChanges().forEach(async ch=>{ if(ch.type==='added'){ try{ await pc.addIceCandidate(ch.doc.data()); }catch{} } });
    });

    setTimeout(async ()=>{ if(pc && pc.connectionState!=='connected' && state.icePolicy==='all'){ await forceRelayAndRestart('Таймаут → TURN'); } }, 9000);
    setStatus('Ожидание собеседника…');
  }catch(e){
    console.error(e); setError('Не удалось создать комнату. См. консоль.');
    setStatus('Ошибка');
  }finally{ creating=false; ui.createBtn.disabled=false; ui.joinBtn.disabled=false; }
}

async function joinByInput(){
  if(joining) return; joining=true; ui.createBtn.disabled=true; ui.joinBtn.disabled=true; setError('');
  try{
    let v=(ui.roomInput.value||'').trim(); if(!v){ joining=false; ui.createBtn.disabled=false; ui.joinBtn.disabled=false; return; }
    try{ if(v.startsWith('http')){ const u=new URL(v); v=u.searchParams.get('room')||v; } }catch{}
    await joinRoom(v);
  }finally{ joining=false; ui.createBtn.disabled=false; ui.joinBtn.disabled=false; }
}

async function joinRoom(roomId){
  cleanupSubs();
  const force = ui.forceTurn.checked || ui.forceTurnSheet?.checked; state.icePolicy = force ? 'relay' : 'all'; persist('forceRelay', force);
  try{
    setStatus('Получаем ICE…');
    state.iceServers = await getIceServers();
    if(!Array.isArray(state.iceServers)) state.iceServers=[{ urls:['stun:stun.l.google.com:19302'] }];

    setStatus('Доступ к микрофону…');
    await buildAudio();
    createPeer();
    const track=outStream().getAudioTracks()[0];
    pc.addTrack(track, outStream());

    setStatus('Подключаемся…');
    roomRef = doc(db,'rooms',roomId);
    const firstSnap=await getDoc(roomRef); if(!firstSnap.exists()){ setError('Комната не найдена'); setStatus('Ошибка'); return; }
    const off=firstSnap.data().offer;
    if(!off){ setError('Нет оффера в комнате'); setStatus('Ошибка'); return; }
    currentOfferSdp = off.sdp;
    await pc.setRemoteDescription(new RTCSessionDescription(off));
    let ans=await pc.createAnswer(); ans.sdp=tuneOpus(ans.sdp);
    await pc.setLocalDescription(ans);
    await updateDoc(roomRef,{ answer:{type:ans.type,sdp:ans.sdp, ts: Date.now()} });

    calleeCandCol = collection(roomRef,'calleeCandidates'); callerCandCol = collection(roomRef,'callerCandidates'); msgCol = collection(roomRef,'messages'); subMessages();
    pc.onicecandidate=async(ev)=>{ if(ev.candidate){ await addDoc(calleeCandCol, ev.candidate.toJSON()); } };

    // Слушаем новые offer только в stable (ICE‑рестарты)
    roomUnsub = onSnapshot(roomRef, async (rsnap)=>{
      const data=rsnap.data(); const newOff=data?.offer;
      if(!newOff || newOff.sdp === currentOfferSdp) return;
      if(pc.signalingState !== 'stable') return;
      currentOfferSdp=newOff.sdp;
      await pc.setRemoteDescription(new RTCSessionDescription(newOff));
      let newAns=await pc.createAnswer(); newAns.sdp=tuneOpus(newAns.sdp);
      await pc.setLocalDescription(newAns);
      await updateDoc(roomRef,{ answer:{type:newAns.type,sdp:newAns.sdp, ts: Date.now()} });
    });
    callerIceUnsub = onSnapshot(callerCandCol, (snap)=>{ snap.docChanges().forEach(async ch=>{ if(ch.type==='added'){ try{ await pc.addIceCandidate(ch.doc.data()); }catch{} } }); });

    setTimeout(async ()=>{ if(pc && pc.connectionState!=='connected' && state.icePolicy==='all'){ await forceRelayAndRestart('Таймаут → TURN'); } }, 9000);
    setStatus('Подключаемся…');
  }catch(e){
    console.error(e); setError('Не удалось подключиться. См. консоль.'); setStatus('Ошибка');
  }
}

function startCallUI(){ setInCall(true); callStartTs=Date.now(); if(timerId) clearInterval(timerId); timerId=setInterval(updateTimer,1000); updateTimer(); postSys('call_started'); }
function stopCallUI(){ setInCall(false); ui.callTime.textContent=''; if(timerId) clearInterval(timerId); callStartTs=0; connectedOnce=false; ui.chat.classList.add('hidden'); ui.chatToggle.setAttribute('aria-expanded','false'); stopWatchdog(); }
async function hangUp(){
  try{
    if(callStartTs){ await postSys('call_ended',{duration:Math.round((Date.now()-callStartTs)/1000)}); }
    stopCallUI(); setStatus('Звонок завершён');
    if(pc){ pc.getSenders().forEach(s=>s.track&&s.track.stop()); pc.close(); }
    cleanupSubs();
    if(roomRef){
      try{
        await updateDoc(roomRef,{endedAt:serverTimestamp()});
        const cols=['callerCandidates','calleeCandidates'];
        for(const c of cols){
          const col=collection(roomRef,c);
          const sn=await getDocs(col);
          await Promise.all(sn.docs.map(d=>deleteDoc(d.ref)));
        }
      }catch{}
    }
  }finally{ pc=null; role=null; }
}

function showLink(id){ ui.linkBox.hidden=false; ui.roomLink.textContent=roomLinkFromId(id); }
async function copyLink(){ const l=ui.roomLink.textContent || roomLinkFromId(ui.roomInput.value.trim()||''); if(!l) return; try{ await navigator.clipboard.writeText(l); showToast('Ссылка скопирована'); }catch{} }

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
  try{ const a=initializeApp(firebaseConfig); app=a; auth=getAuth(a); await signInAnonymously(auth); db=getFirestore(a);}catch(e){ setStatus('Firebase не инициализирован'); console.error(e); }
  ui.createBtn.addEventListener('click',createRoom); ui.joinBtn.addEventListener('click',joinByInput); ui.copyBtn.addEventListener('click',copyLink);
  ui.openSettingsBtn.addEventListener('click',()=>toggleSheet(true)); ui.closeSettingsBtn.addEventListener('click',()=>toggleSheet(false));
  ui.sendBtn.addEventListener('click',sendText); ui.messageInput.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); sendText(); }});
  ui.chatToggle.addEventListener('click',()=>{ const h=ui.chat.classList.contains('hidden'); ui.chat.classList.toggle('hidden',!h); ui.chatToggle.setAttribute('aria-expanded', String(h)); });
  ui.muteBtn.addEventListener('click',()=>{ isMuted=!isMuted; const s=outStream(); if(s){ s.getAudioTracks().forEach(t=>t.enabled=!isMuted);} ui.muteBtn.setAttribute('aria-pressed',String(isMuted)); });
  ui.deafenBtn.addEventListener('click',()=>{ isDeaf=!isDeaf; ui.remoteAudio.muted=isDeaf; ui.deafenBtn.setAttribute('aria-pressed',String(isDeaf)); });
  ui.endBtn.addEventListener('click',hangUp);
  ui.micGain.addEventListener('input',()=>{ persist('micGain',parseFloat(ui.micGain.value)); });
  ui.outGain.addEventListener('input',()=>{ const v=parseFloat(ui.outGain.value); ui.remoteAudio.volume=v; persist('outGain',v); });
  ui.gate.addEventListener('input',()=>{ persist('gate', parseFloat(ui.gate.value)); });
  const savedRelay = restore('forceRelay', false); ui.forceTurn.checked=savedRelay; if(ui.forceTurnSheet) ui.forceTurnSheet.checked=savedRelay;
  ui.forceTurn.addEventListener('change',()=>{ const flag=ui.forceTurn.checked; if(ui.forceTurnSheet) ui.forceTurnSheet.checked=flag; persist('forceRelay',flag); });

  // auto join by ?room=
  const params=new URLSearchParams(location.search); const room=params.get('room'); await prepareDevices(); await buildAudio();
  if(room){ ui.roomInput.value=room; await joinRoom(room);} else { setStatus('Готов'); }
}
init();
