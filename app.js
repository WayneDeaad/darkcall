import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, updateDoc,
  onSnapshot, serverTimestamp, deleteDoc, getDocs, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

/** ===== Helpers ===== */
function uid(){ try{ const a=new Uint32Array(2); crypto.getRandomValues(a); return (a[0].toString(36)+a[1].toString(36)).slice(0,8);}catch{ return Math.random().toString(36).slice(2,10);} }
function formatTime(ts){
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function formatDuration(sec){
  const m = Math.floor(sec/60); const s = sec%60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

/** ===== UI ===== */
const ui = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  settings: document.getElementById('settings'),

  // precall
  precall: document.getElementById('precall'),
  roomInput: document.getElementById('roomIdInput'),
  createBtn: document.getElementById('createBtn'),
  joinBtn: document.getElementById('joinBtn'),
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  linkBox: document.getElementById('linkBox'),
  roomLink: document.getElementById('roomLink'),

  // call
  call: document.getElementById('callScreen'),
  callTime: document.getElementById('callTime'),
  pulse: document.getElementById('pulseCircle'),
  muteBtn: document.getElementById('muteBtn'),
  endBtn: document.getElementById('endBtn'),
  deafenBtn: document.getElementById('deafenBtn'),
  remoteAudio: document.getElementById('remoteAudio'),
  chat: document.getElementById('chat'),
  chatToggle: document.getElementById('chatToggle'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),

  // sheet fields
  micSelect: document.getElementById('micSelect'),
  echo: document.getElementById('echoCancellation'),
  noise: document.getElementById('noiseSuppression'),
  agc: document.getElementById('autoGainControl'),
};

let app, db, auth;
let pc, localStream, remoteStream, role = null;
let roomRef, callerCandidatesCol, calleeCandidatesCol, messagesCol, messagesUnsub = null;
let callStartTs = 0, timerId = null;
let isMuted = false, isDeaf = false;
let connectedOnce = false;
let user = { id: uid(), name: 'User-' + Math.random().toString(36).slice(2,6) };

const rtcConfig = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
    // Добавь свой TURN для 100% связности:
    // { urls: 'turn:YOUR_TURN:3478', username: 'USER', credential: 'PASS' },
    // { urls: 'turns:YOUR_TURN:5349?transport=tcp', username: 'USER', credential: 'PASS' },
  ],
  iceCandidatePoolSize: 10,
};

function setStatus(state, text){
  ui.statusText.textContent = text;
  ui.statusDot.className = 'dot ' + ({
    idle: 'dot-idle', connecting: 'dot-connecting', connected: 'dot-connected', error: 'dot-error'
  }[state] || 'dot-idle');
}

function toggleSheet(open){
  ui.settings.classList.toggle('open', open);
  ui.settings.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function setInCall(active){
  ui.precall.classList.toggle('hidden', active);
  ui.call.classList.toggle('hidden', !active);
  ui.muteBtn.disabled = !active;
  ui.endBtn.disabled = !active;
  ui.deafenBtn.disabled = !active;
  ui.messageInput.disabled = !active;
  ui.sendBtn.disabled = !active;
  ui.chatToggle.setAttribute('aria-expanded', active ? 'true' : 'false');
}

function roomLinkFromId(id){
  const url = new URL(window.location.href);
  url.searchParams.set('room', id);
  return url.toString();
}

function updateCallTimer(){
  if(!callStartTs) return;
  const s = Math.floor((Date.now() - callStartTs)/1000);
  ui.callTime.textContent = formatDuration(s);
}

function getAudioConstraints(){
  const deviceId = ui.micSelect.value || undefined;
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: ui.echo.checked,
      noiseSuppression: ui.noise.checked,
      autoGainControl: ui.agc.checked,
      channelCount: 1,
    },
    video: false
  };
}

async function prepareDevices(){
  try{
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    tmp.getTracks().forEach(t => t.stop());
  }catch{}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  ui.micSelect.innerHTML = '';
  for(const d of mics){
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Микрофон';
    ui.micSelect.appendChild(opt);
  }
}

async function getLocalStream(){
  if(localStream){ localStream.getTracks().forEach(t => t.stop()); }
  localStream = await navigator.mediaDevices.getUserMedia(getAudioConstraints());
  return localStream;
}

function tuneOpusInSDP(sdp){
  const m = sdp.split('\r\n');
  const mAudioIdx = m.findIndex(l => l.startsWith('m=audio'));
  if(mAudioIdx === -1) return sdp;
  const rtpmap = m.filter(l => l.startsWith('a=rtpmap:') && l.includes('opus/48000'));
  if(!rtpmap.length) return sdp;
  const pt = rtpmap[0].split(':')[1].split(' ')[0];
  const parts = m[mAudioIdx].split(' ');
  const header = parts.slice(0,3);
  const pts = [pt, ...parts.slice(3).filter(x => x !== pt)];
  m[mAudioIdx] = [...header, ...pts].join(' ');
  const fmtpIdx = m.findIndex(l => l.startsWith('a=fmtp:' + pt));
  const fmtpLine = 'a=fmtp:' + pt + ' minptime=10;useinbandfec=1;stereo=0;maxaveragebitrate=96000;ptime=20;usedtx=1';
  if(fmtpIdx === -1){
    const rtpmapIdx = m.findIndex(l => l.startsWith('a=rtpmap:' + pt));
    m.splice(rtpmapIdx + 1, 0, fmtpLine);
  }else{
    m[fmtpIdx] = fmtpLine;
  }
  return m.join('\r\n');
}

async function tuneSender(sender){
  try{
    const params = sender.getParameters();
    if(!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = 96000;
    params.encodings[0].priority = 'high';
    await sender.setParameters(params);
  }catch{}
}

function createPeer(){
  pc = new RTCPeerConnection(rtcConfig);
  remoteStream = new MediaStream();
  ui.remoteAudio.srcObject = remoteStream;
  pc.ontrack = (e) => {
    for(const t of e.streams[0].getAudioTracks()){
      remoteStream.addTrack(t);
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if(st === 'connected'){
      onConnected();
    }else if(st === 'connecting'){ setStatus('connecting', 'Подключение…'); }
    else if(st === 'failed'){ setStatus('error', 'Сбой соединения'); }
    else if(st === 'disconnected'){
      setStatus('idle', 'Отключено');
      if(callStartTs){ postSystem('call_ended', { by: user.id, reason: 'disconnected', duration: Math.round((Date.now()-callStartTs)/1000) }); stopCallUI(); }
    }
  };
  return pc;
}

function onConnected(){
  setStatus('connected', 'Подключено');
  if(!connectedOnce){
    connectedOnce = true;
    startCallUI();
    // «Начал звонок» — публикуем один раз, от имени того кто создал комнату
    if(role === 'caller'){ postSystem('call_started', { by: user.id }); }
  }
}

async function createRoom(){
  try{
    setStatus('connecting', 'Создаём комнату…');
    role = 'caller';
    createPeer();
    const stream = await getLocalStream();
    const track = stream.getAudioTracks()[0];
    pc.addTrack(track, stream);
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    await tuneSender(sender);

    roomRef = await addDoc(collection(db, 'rooms'), { createdAt: serverTimestamp() });
    callerCandidatesCol = collection(roomRef, 'callerCandidates');
    calleeCandidatesCol = collection(roomRef, 'calleeCandidates');
    messagesCol = collection(roomRef, 'messages');
    subscribeMessages();

    pc.onicecandidate = async (event) => {
      if(event.candidate){ await addDoc(callerCandidatesCol, event.candidate.toJSON()); }
    };

    let offer = await pc.createOffer({ offerToReceiveAudio: true });
    offer.sdp = tuneOpusInSDP(offer.sdp);
    await pc.setLocalDescription(offer);
    await setDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp }, createdAt: serverTimestamp() }, { merge: true });

    const roomId = roomRef.id;
    const link = roomLinkFromId(roomId);
    showLink(link);
  }catch(e){
    setStatus('error', 'Не удалось создать комнату');
  }
}

async function joinRoomFromInput(){
  let val = (ui.roomInput.value || '').trim();
  if(!val){ return; }
  try{
    if(val.startsWith('http')){
      const u = new URL(val);
      val = u.searchParams.get('room') || val;
    }
  }catch{}
  await joinRoom(val);
}

async function joinRoom(roomId){
  try{
    setStatus('connecting', 'Подключаемся…');
    role = 'callee';
    createPeer();
    const stream = await getLocalStream();
    const track = stream.getAudioTracks()[0];
    pc.addTrack(track, stream);
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    await tuneSender(sender);

    roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    if(!roomSnap.exists()){ setStatus('error','Комната не найдена'); return; }

    calleeCandidatesCol = collection(roomRef, 'calleeCandidates');
    callerCandidatesCol = collection(roomRef, 'callerCandidates');
    messagesCol = collection(roomRef, 'messages');
    subscribeMessages();

    pc.onicecandidate = async (event) => {
      if(event.candidate){ await addDoc(calleeCandidatesCol, event.candidate.toJSON()); }
    };

    const offer = roomSnap.data().offer;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    let answer = await pc.createAnswer();
    answer.sdp = tuneOpusInSDP(answer.sdp);
    await pc.setLocalDescription(answer);
    await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp }, answeredAt: serverTimestamp() });
  }catch(e){
    setStatus('error', 'Не удалось подключиться');
  }
}

function startCallUI(){
  setInCall(true);
  callStartTs = Date.now();
  if(timerId) clearInterval(timerId);
  timerId = setInterval(updateCallTimer, 1000);
  updateCallTimer();
}

function stopCallUI(){
  setInCall(false);
  ui.callTime.textContent = '';
  if(timerId) clearInterval(timerId);
  callStartTs = 0; connectedOnce = false;
  ui.chat.classList.add('hidden');
  ui.chatToggle.setAttribute('aria-expanded','false');
}

async function hangUp(){
  try{
    if(callStartTs){ postSystem('call_ended', { by: user.id, reason: 'hangup', duration: Math.round((Date.now()-callStartTs)/1000) }); }
    stopCallUI();
    setStatus('idle', 'Звонок завершён');
    if(pc){ pc.getSenders().forEach(s => s.track && s.track.stop()); pc.close(); }
    if(localStream){ localStream.getTracks().forEach(t => t.stop()); }
    if(remoteStream){ remoteStream.getTracks().forEach(t => t.stop()); }
    if(roomRef){
      try{
        // Не удаляем комнату полностью, чтобы чат/история сохранились
        await updateDoc(roomRef, { endedAt: serverTimestamp() });
        // Можно подчистить кандидатов
        const cols = ['callerCandidates', 'calleeCandidates'];
        for(const c of cols){
          const colRef = collection(roomRef, c);
          const snaps = await getDocs(colRef);
          await Promise.all(snaps.docs.map(d => deleteDoc(d.ref)));
        }
      }catch{}
    }
  }finally{
    pc=null; role=null;
  }
}

function showLink(link){
  ui.linkBox.hidden = false;
  ui.roomLink.textContent = link;
}

async function copyLink(){
  const link = ui.roomLink.textContent || roomLinkFromId(ui.roomInput.value.trim() || '');
  if(!link) return;
  try{ await navigator.clipboard.writeText(link); }catch{}
}

/** ===== Chat ===== */
function subscribeMessages(){
  if(messagesUnsub) messagesUnsub(); // пере-подписка безопасна
  const q = query(messagesCol, orderBy('createdAt','asc'), limit(200));
  messagesUnsub = onSnapshot(q, (snap) => {
    ui.messages.innerHTML = '';
    snap.forEach(doc => renderMessage(doc.data()));
    ui.messages.scrollTop = ui.messages.scrollHeight;
  });
}

async function postSystem(kind, extra={}){
  if(!messagesCol) return;
  const payload = { type: 'system', kind, createdAt: serverTimestamp(), ...extra };
  try{ await addDoc(messagesCol, payload); }catch{}
}

async function sendText(){
  const text = ui.messageInput.value.trim();
  if(!text || !messagesCol) return;
  ui.messageInput.value='';
  try{
    await addDoc(messagesCol, {
      type: 'text',
      text,
      from: user.id,
      name: user.name,
      createdAt: serverTimestamp()
    });
  }catch{}
}

function renderMessage(m){
  if(m.type === 'system'){
    let t = '';
    if(m.kind === 'call_started'){ t = 'Звонок начался'; }
    else if(m.kind === 'call_ended'){ t = 'Звонок завершён' + (m.duration ? ` (${formatDuration(m.duration)})` : ''); }
    const div = document.createElement('div');
    div.className = 'msg-system';
    div.textContent = t;
    ui.messages.appendChild(div);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble ' + (m.from === user.id ? 'msg-right' : '');
  wrap.textContent = m.text;
  ui.messages.appendChild(wrap);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const who = m.from === user.id ? 'Ты' : (m.name || 'Гость');
  meta.textContent = `${who} • ${m.createdAt?.toDate ? formatTime(m.createdAt.toDate()) : ''}`;
  ui.messages.appendChild(meta);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function toggleChat(){
  const isHidden = ui.chat.classList.contains('hidden');
  ui.chat.classList.toggle('hidden', !isHidden);
  ui.chatToggle.setAttribute('aria-expanded', String(isHidden));
  if(isHidden){ ui.messageInput.focus(); }
}

/** ===== Refresh audio track on settings changes ===== */
async function refreshAudioTrack(){
  if(!pc) return;
  const newStream = await getLocalStream();
  const newTrack = newStream.getAudioTracks()[0];
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
  if(sender && newTrack){ await sender.replaceTrack(newTrack); await tuneSender(sender); }
}

/** ===== Init ===== */
async function init(){
  try{
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    await signInAnonymously(auth);
    db = getFirestore(app);
  }catch(e){
    setStatus('error', 'Firebase не инициализирован');
  }

  ui.createBtn.addEventListener('click', createRoom);
  ui.joinBtn.addEventListener('click', joinRoomFromInput);
  ui.copyLinkBtn.addEventListener('click', copyLink);
  ui.muteBtn.addEventListener('click', toggleMute);
  ui.deafenBtn.addEventListener('click', toggleDeafen);
  ui.endBtn.addEventListener('click', hangUp);
  ui.openSettingsBtn.addEventListener('click', () => toggleSheet(true));
  ui.closeSettingsBtn?.addEventListener('click', () => toggleSheet(false));
  ui.micSelect.addEventListener('change', refreshAudioTrack);
  [ui.echo, ui.noise, ui.agc].forEach(el => el.addEventListener('change', refreshAudioTrack));
  ui.sendBtn.addEventListener('click', sendText);
  ui.messageInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendText(); } });
  ui.chatToggle.addEventListener('click', toggleChat);

  // Автоподключение по ?room=
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if(room){ ui.roomInput.value = room; joinRoom(room); }

  await prepareDevices();
  setStatus('idle', 'Готов');
}

/** ===== Controls ===== */
async function toggleMute(){
  isMuted = !isMuted;
  if(localStream){
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  ui.muteBtn.setAttribute('aria-pressed', String(isMuted));
  const micPath = document.getElementById('micPath');
  if(isMuted){
    micPath.setAttribute('d','M19 11a7 7 0 01-7 7v3h-2v-3a7 7 0 01-6-7h2a5 5 0 0010 0h3zM12 14a3 3 0 003-3V6a3 3 0 10-6 0v1.59l7.7 7.7-1.4 1.42L10 9.41V11a3 3 0 003 3z');
  }else{
    micPath.setAttribute('d','M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 0014 0h-2z');
  }
}

function toggleDeafen(){
  isDeaf = !isDeaf;
  ui.remoteAudio.muted = isDeaf;
  ui.deafenBtn.setAttribute('aria-pressed', String(isDeaf));
}

init();
