import { createRecordingController, supportedMime } from './recorder.js';
import { CameraMesh } from './mesh.js';
const $ = id => document.getElementById(id);
let me = null, stream = null, controller = null, wake = null, facing = 'environment', paused = false, joining = false;
const peers = new Map();
let mesh = null;
let liveId = null, signalQueue = Promise.resolve();
let latestTake = null;
let armed = false, clockOffset = 0, hostId = null, currentTake = null, storageReady = false, takeTimer;
let cameraOptions = { bitrate: 10000000, previewBitrate: 400000, audio: false };
const roomVideos = new Map();
const message = text => { $('message').textContent = text; $('message').hidden = !text; };
const recording = createRecordingController({ api, getStream: () => stream, getOptions: () => cameraOptions, notify: message, onState: active => {
  $('flip').disabled = $('pause').disabled = active;
  $('apply-camera').disabled = active; publishCamera().catch(() => {}); updateRecordingUI();
} });
recording.refresh();
const shareCode = new URL(location.href).searchParams.get('room');
if (shareCode) $('room-code').value = shareCode;
$('name').value = localStorage.getItem('camroom-name') || '';

async function api(path, data, session = me) {
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: JSON.stringify(data), signal: AbortSignal.timeout(path === 'signal' ? 10000 : ['record/start', 'record/delete'].includes(path) ? 180000 : 30000) });
  const result = await res.json(); if (!res.ok) throw Error(result.error || 'Không kết nối được máy chủ.'); return result;
}
function captureConstraints(max = 3) {
  return { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } };
}
async function keepAwake() {
  if (me && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    try { wake = await navigator.wakeLock.request('screen'); } catch { /* Device may refuse while battery is low. */ }
  }
}
document.addEventListener('visibilitychange', keepAwake);

async function join(create = false) {
  if (joining || me) return;
  if (!$('join-form').reportValidity()) return;
  joining = true; message('Đang kết nối…');
  const role = document.querySelector('input[name="role"]:checked').value;
  const code = $('room-code').value.trim().toUpperCase();
  try {
    if (!create && !/^[A-F0-9]{12}$/.test(code)) throw Error('Nhập mã phòng gồm 12 ký tự từ người tạo phòng.');
    if (role === 'camera') {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Camera cần HTTPS. Hãy mở link HTTPS của web trên điện thoại.');
      stream = await navigator.mediaDevices.getUserMedia(captureConstraints(create ? Number($('max-cameras').value) : 10));
    }
    me = await api('join', { create, code, role, name: $('name').value, maxCameras: Number($('max-cameras').value) }, null);
    const session = me;
    mesh = new CameraMesh({ selfId: me.id, peers, getStream: () => stream, getConfiguration: () => session,
      getPreview: () => ({ bitrate: cameraOptions.previewBitrate, fps: me?.maxCameras > 3 ? 15 : 24, maxDimension: me?.maxCameras > 3 ? 854 : 1280 }),
      send: data => api('signal', data, session), onStream: attachRemoteStream, onState: connectionState });
    hostId = me.hostId; storageReady = me.storage; currentTake = me.take; latestTake = me.latestTake; armed = false;
    await recording.reconcile(me.code, latestTake, (me.recordings || []).map(job => job.id));
    roomVideos.clear(); for (const job of me.recordings || []) roomVideos.set(job.id, job);
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const start = Date.now(), server = await api('time', {}), end = Date.now(); if (end - start < best) { best = end - start; clockOffset = server.now - (start + end) / 2; } }
    localStorage.setItem('camroom-name', $('name').value);
    if (stream) {
      try { await stream.getVideoTracks()[0].applyConstraints(captureConstraints(me.maxCameras).video); } catch { /* Keep the supported capture mode. */ }
      watchTrack(stream.getVideoTracks()[0]);
    }
    $('settings').close(); $('lobby').hidden = true; $('studio').hidden = false;
    $('code').textContent = me.code;
    $('identity').textContent = role === 'camera' ? `◉ CAM ${String(me.slot).padStart(2, '0')} · ${me.name}` : `▦ Chỉ xem · ${me.name}`;
    $('pause').hidden = $('flip').hidden = role !== 'camera';
    $('connection').textContent = 'Đang nối phòng…';
    history.replaceState(null, '', `?room=${me.code}`);
    render(); renderSettings(); updateRecordingUI(); message(''); keepAwake();
    controller = new AbortController();
    readEvents(me, controller.signal).catch(async error => {
      if (error.name !== 'AbortError' && me) { await leave(); message('Mất kết nối máy chủ. Kiểm tra mạng rồi tham gia lại phòng.'); }
    });
  } catch (error) {
    if (me) await leave(); else { stream?.getTracks().forEach(t => t.stop()); stream = null; }
    const friendly = { NotAllowedError: 'Bạn chưa cho phép mở camera. Hãy cấp quyền camera trong trình duyệt rồi thử lại.', NotFoundError: 'Không tìm thấy camera trên thiết bị.', NotReadableError: 'Camera đang bận. Đóng ứng dụng đang dùng camera rồi thử lại.' };
    message(friendly[error.name] || error.message);
    if ($('settings').open) $('settings').close();
  } finally { joining = false; }
}
async function readEvents(session, signal) {
  const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${session.token}` }, signal });
  if (!response.ok) throw Error('Không mở được kết nối.');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) throw Error('Mất kết nối.');
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!line.startsWith('data: ')) continue;
      const { type, data } = JSON.parse(line.slice(6));
      signalQueue = signalQueue.then(async () => { if (me?.id === session.id) await handleEvent(type, data); }).catch(error => { if (me?.id === session.id) message(`Kết nối camera: ${error.message}`); });
    }
  }
}
async function handleEvent(type, data) {
  if (type === 'welcome') {
    $('connection').textContent = 'Đã kết nối phòng'; liveId = data.live;
    hostId = data.hostId; storageReady = data.storage; currentTake = data.take; latestTake = data.latestTake;
    await recording.reconcile(me.code, latestTake, (data.recordings || []).map(job => job.id));
    for (const job of data.recordings || []) roomVideos.set(job.id, job);
    for (const p of data.peers) peers.set(p.id, p);
    render(); renderSettings(); updateRecordingUI(); await publishCamera();
    await mesh.connectAll(); updateNetworkNote();
  }
  if (type === 'joined') { peers.set(data.id, data); render(); await mesh.connectAll(); updateNetworkNote(); }
  if (type === 'left') {
    peers.delete(data.id); mesh.remove(data.id);
    document.getElementById(`cam-${data.id}`)?.remove(); render(); updateNetworkNote();
  }
  if (type === 'live') { liveId = data.id; updateLive(); }
  if (type === 'signal') await mesh.receive(data);
  if (type === 'host') { hostId = data.id; renderSettings(); updateRecordingUI(); }
  if (type === 'camera-state') {
    if (data.id === me.id) me.camera = data.camera; else if (peers.has(data.id)) peers.set(data.id, data);
    updateRecordingUI();
    if ($('config-target').value === data.id) renderSettings(data.id);
  }
  if (type === 'camera-config') { await applyCameraConfig(data); }
  if (type === 'record-start') { await recording.start({ ...data, clockOffset }, data.scheduledAt - (Date.now() + clockOffset)); }
  if (type === 'record-stop') { recording.stop(data.id, Math.max(0, data.stopAt - Date.now() - clockOffset)).catch(e => message(e.message)); }
  if (type === 'recordings-deleted') { for (const id of data.ids) roomVideos.delete(id); await recording.discard(data.ids); renderRoomVideos(); }
  if (type === 'recordings-reset') {
    latestTake = data.take; roomVideos.clear();
    currentTake = { id: data.take, active: true, preparing: true, cameraIds: [] };
    await recording.retainRoomTake(data.room, data.take); updateRecordingUI();
  }
  if (type === 'take') { currentTake = data; for (const job of data?.recordings || []) roomVideos.set(job.id, job); updateRecordingUI(); }
  if (type === 'recording-status' && data.take === latestTake) { roomVideos.set(data.id, data); updateRecordingUI(); }
  if (type === 'neon-recordings') { for (const job of data) if (job.take === latestTake && job.state !== 'deleted') roomVideos.set(job.id, job); renderRoomVideos(); }
  if (type === 'cloud-status') $('cloud-status').textContent = data.status === 'live' ? 'Neon Realtime: đang đồng bộ video' : `Neon Realtime: ${data.status}. Trạng thái trực tiếp vẫn qua máy chủ phòng.`;
}
function updateNetworkNote() {
  if (!me) return;
  const cameras = [...peers.values()].filter(p => p.role === 'camera');
  const received = cameras.filter(p => { const video = document.getElementById(`video-${p.id}`); return video?.srcObject && video.readyState >= 2 && !video.paused; }).length;
  $('network-status').textContent = `Đang xem ${received}/${cameras.length} camera khác. ${me.turnConfigured ? 'Đã cấu hình chuyển tiếp mạng (TURN).' : 'Chưa có TURN: các máy khác Wi-Fi hoặc 4G/5G có thể không thấy nhau. Cần cấu hình TURN trên server.'}`;
}
function connectionState(other, direction, state) {
  const card = document.getElementById(`cam-${other}`); if (!card) return;
  if (direction === 'send') {
    card.querySelector('.send-status').textContent = state === 'failed' ? 'Không gửi được camera của bạn tới máy này; kiểm tra TURN/mạng.' : state === 'retrying' ? 'Đang thử gửi lại camera của bạn tới máy này…' : '';
    return;
  }
  const video = card.querySelector('video');
  if (state === 'failed') status(other, me.turnConfigured ? 'Kết nối camera thất bại. Kiểm tra TURN/đường mạng hoặc bấm Kết nối lại.' : 'Không nối được trực tiếp. Các máy khác mạng cần TURN trên server.');
  else if (state === 'retrying' || state === 'disconnected') status(other, 'Mạng gián đoạn · đang tự kết nối lại…');
  else if (state === 'connected') status(other, video.readyState >= 2 && !video.paused ? 'Đang nhận hình' : 'Đã kết nối · chờ hình ảnh', video.readyState >= 2 && !video.paused);
  updateNetworkNote();
}
function attachRemoteStream(other, remoteStream, track) {
  const card = document.getElementById(`cam-${other}`), video = card?.querySelector('video'); if (!video) return;
  const playButton = card.querySelector('.play-camera');
  const play = () => video.play().then(() => { playButton.hidden = true; updateNetworkNote(); }).catch(() => { playButton.hidden = false; status(other, 'Trình duyệt chặn tự phát. Bấm Hiện hình.'); });
  video.onplaying = () => { playButton.hidden = true; status(other, 'Đang nhận hình', true); updateNetworkNote(); };
  video.srcObject = remoteStream; video.muted = true; video.playsInline = true;
  playButton.onclick = play;
  track.onmute = () => { if (video.srcObject === remoteStream) status(other, 'Camera tạm dừng hoặc mạng yếu'); };
  track.onunmute = () => { if (video.srcObject === remoteStream) play(); };
  play();
}
function status(id, text, playing = false) {
  const card = document.getElementById(`cam-${id}`); if (!card) return;
  card.querySelector('.cam-status').textContent = text;
  card.querySelector('.overlay').textContent = text;
  card.querySelector('.overlay').hidden = playing;
}
function render() {
  if (!me) return;
  $('count').textContent = `${peers.size + 1}/10 thiết bị`;
  const cameras = [me, ...peers.values()].filter(p => p.role === 'camera').sort((a, b) => a.slot - b.slot);
  $('grid').querySelectorAll('.empty').forEach(el => el.remove());
  for (const p of cameras) {
    if (document.getElementById(`cam-${p.id}`)) continue;
    const card = document.createElement('article'); card.className = 'camera'; card.id = `cam-${p.id}`;
    card.innerHTML = '<div class="video-wrap"><video autoplay playsinline muted></video><span class="overlay">Đang kết nối camera…</span><span class="badge"></span></div><div class="cam-info"><h3></h3><p class="cam-status">Đang kết nối</p><p class="send-status"></p><div class="cam-rec"></div><div class="cam-buttons"><button class="tally">Lên hình</button><button class="secondary expand">⛶ Phóng to</button><button class="secondary reconnect">↻ Kết nối lại</button><button class="secondary play-camera" hidden>▶ Hiện hình</button></div></div>';
    const video = card.querySelector('video'); video.id = `video-${p.id}`;
    card.querySelector('h3').textContent = `${p.name}${p.id === me.id ? ' (bạn)' : ''}`;
    card.querySelector('.badge').textContent = `CAM ${String(p.slot).padStart(2, '0')}`;
    card.querySelector('.tally').onclick = () => api('live', { id: p.id }).catch(e => message(e.message));
    card.querySelector('.reconnect').hidden = p.id === me.id;
    card.querySelector('.reconnect').onclick = () => mesh.reconnect(p.id);
    card.querySelector('.expand').onclick = async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else if (card.requestFullscreen) await card.requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else card.classList.toggle('focused'); } catch { card.classList.toggle('focused'); }
    };
    $('grid').append(card);
    if (p.id === me.id) { video.srcObject = stream; status(p.id, paused ? 'Camera đang tạm dừng' : 'Camera của bạn', !paused); }
  }
  for (let slot = 1; slot <= me.maxCameras; slot++) {
    if (cameras.some(p => p.slot === slot)) continue;
    const card = document.createElement('article'); card.className = 'camera empty';
    card.innerHTML = `<div class="video-wrap">＋</div><div class="cam-info"><h3>CAM ${String(slot).padStart(2, '0')}</h3><p>Đang chờ điện thoại tham gia</p></div>`;
    $('grid').append(card);
  }
  updateLive();
  renderSettings(); updateRecordingUI();
}
function updateLive() {
  const p = [me, ...peers.values()].find(p => p?.id === liveId);
  $('on-air').textContent = p ? `● ĐANG LÊN HÌNH: ${p.name}` : 'Chưa chọn máy lên hình';
  document.querySelectorAll('.camera:not(.empty)').forEach(card => {
    const active = card.id === `cam-${liveId}`; card.classList.toggle('live', active);
    card.querySelector('.tally').textContent = active ? '● Đang lên hình' : 'Lên hình';
  });
}
function watchTrack(track) {
  track.onended = () => { if (me) { paused = true; armed = false; publishCamera('Camera đã bị hệ điều hành dừng.').catch(() => {}); status(me.id, 'Camera đã dừng. Hãy rời phòng và vào lại.'); message('Camera bị hệ điều hành dừng. Giữ trang mở; rời phòng và vào lại để bật camera.'); } };
}
async function leave() {
  await recording.stop(); armed = false;
  const old = me; me = null; controller?.abort(); controller = null;
  mesh?.close(); mesh = null; peers.clear();
  hostId = null; currentTake = null; latestTake = null; clearInterval(takeTimer);
  stream?.getTracks().forEach(t => t.stop()); stream = null; paused = false; liveId = null;
  try { await wake?.release(); } catch {} wake = null;
  $('grid').replaceChildren(); $('studio').hidden = true; $('lobby').hidden = false;
  $('connection').textContent = 'Sẵn sàng kết nối'; $('pause').textContent = 'Tạm dừng camera';
  if (old) { $('room-code').value = old.code; await api('leave', {}, old).catch(() => {}); }
}
$('join-form').onsubmit = e => { e.preventDefault(); join(); };
$('create').onclick = () => { if ($('join-form').reportValidity()) $('settings').showModal(); };
$('cancel-create').onclick = () => $('settings').close();
$('create-form').onsubmit = e => { e.preventDefault(); join(true); };
$('leave').onclick = () => { leave(); message('Bạn đã rời phòng.'); };
$('clear-live').onclick = () => api('live', { id: null }).catch(e => message(e.message));
$('pause').onclick = () => {
  if (recording.active) return;
  if (!stream) return; paused = !paused; stream.getVideoTracks().forEach(t => t.enabled = !paused);
  $('pause').textContent = paused ? 'Tiếp tục camera' : 'Tạm dừng camera';
  status(me.id, paused ? 'Camera đang tạm dừng' : 'Camera của bạn', !paused);
  armed = false; publishCamera().catch(e => message(e.message));
};
$('flip').onclick = async () => {
  if (!me || !stream || recording.active) return;
  $('flip').disabled = true;
  const session = me, oldFacing = facing;
  // Mobile browsers often require releasing the current camera before opening the other lens.
  stream.getTracks().forEach(t => t.stop()); facing = facing === 'environment' ? 'user' : 'environment';
  let next;
  try { next = await navigator.mediaDevices.getUserMedia(captureConstraints(me.maxCameras)); }
  catch { facing = oldFacing; try { next = await navigator.mediaDevices.getUserMedia(captureConstraints(session.maxCameras)); message('Không đổi được camera, đã bật lại camera cũ.'); } catch { await leave(); message('Không mở lại được camera. Hãy tham gia lại phòng.'); } }
  try {
    if (!next) return;
    if (me?.id !== session.id) { next.getTracks().forEach(t => t.stop()); return; }
    stream = next; const track = next.getVideoTracks()[0]; track.enabled = !paused; watchTrack(track);
    await Promise.allSettled([...mesh.outgoing.entries()].map(async ([other, pc]) => {
      try { await pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(track); await mesh.applyPreview(pc); }
      catch { await mesh.ensureSender(other, { force: true }); }
    }));
    document.getElementById(`video-${me.id}`).srcObject = next;
    status(me.id, paused ? 'Camera đang tạm dừng' : 'Camera của bạn', !paused);
    armed = false; await publishCamera(); renderSettings(me.id);
  } catch (e) { message(`Không đổi được camera: ${e.message}`); } finally { $('flip').disabled = false; }
};
$('copy').onclick = async () => {
  const url = `${location.origin}/?room=${me.code}`;
  try { await navigator.clipboard.writeText(url); message('Đã sao chép link. Gửi link này cho các điện thoại cùng nhóm.'); } catch { message(`Link phòng: ${url}`); }
};
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(t => t.stop()); controller?.abort(); });
window.addEventListener('pageshow', e => { if (e.persisted && me) { leave(); message('Trang đã được khôi phục. Tham gia lại để mở camera.'); } });

const advancedControls = {
  zoom: 'Zoom', focusMode: 'Chế độ lấy nét', focusDistance: 'Khoảng lấy nét', exposureMode: 'Chế độ phơi sáng',
  exposureTime: 'Thời gian phơi sáng', exposureCompensation: 'Bù phơi sáng', iso: 'ISO', whiteBalanceMode: 'Cân bằng trắng',
  colorTemperature: 'Nhiệt độ màu', brightness: 'Độ sáng', contrast: 'Tương phản', saturation: 'Độ bão hòa', sharpness: 'Độ nét', torch: 'Đèn flash liên tục',
};
async function publishCamera(error = '') {
  if (!me || me.role !== 'camera' || !stream) return;
  const track = stream.getVideoTracks()[0], caps = track.getCapabilities?.() || {};
  const capabilities = Object.fromEntries(Object.keys(advancedControls).filter(key => key in caps).map(key => [key, caps[key]]));
  capabilities.width = caps.width; capabilities.height = caps.height; capabilities.frameRate = caps.frameRate;
  const settings = { ...track.getSettings(), recordBitrate: cameraOptions.bitrate, previewBitrate: cameraOptions.previewBitrate, audio: cameraOptions.audio };
  delete settings.deviceId; delete settings.groupId;
  const camera = { ready: armed && !paused && !recording.active && track.readyState === 'live' && Boolean(supportedMime()), settings, capabilities, mime: supportedMime(), error };
  me.camera = camera; await api('camera-state', camera);
}
function renderSettings(selected = $('config-target').value) {
  if (!me) return;
  const cameras = [me, ...peers.values()].filter(p => p.role === 'camera' && (hostId === me.id || p.id === me.id));
  const target = $('config-target'); target.replaceChildren();
  for (const p of cameras) { const option = document.createElement('option'); option.value = p.id; option.textContent = `CAM ${p.slot} · ${p.name}`; target.append(option); }
  if (cameras.some(p => p.id === selected)) target.value = selected;
  else if (cameras.some(p => p.id === me.id)) target.value = me.id;
  const p = cameras.find(p => p.id === target.value), settings = p?.camera?.settings || {}, caps = p?.camera?.capabilities || {};
  $('camera-config-form').hidden = !p;
  $('actual-settings').textContent = p?.camera ? `Thực tế: ${settings.width}×${settings.height} · ${Number(settings.frameRate || 0).toFixed(1)} fps · ${p.camera.mime || 'không hỗ trợ ghi'}${p.camera.error ? ` · ${p.camera.error}` : ''}` : 'Camera chưa báo khả năng cấu hình.';
  const resolution = `${Math.max(settings.width || 0, settings.height || 0)}x${Math.min(settings.width || 0, settings.height || 0)}`;
  if ([...$('resolution').options].some(o => o.value === resolution)) $('resolution').value = resolution;
  $('fps').value = Math.round(settings.frameRate || 30);
  if (caps.frameRate) { $('fps').min = Math.max(1, Math.ceil(caps.frameRate.min)); $('fps').max = Math.floor(caps.frameRate.max); }
  $('record-bitrate').value = String(settings.recordBitrate || 10000000); $('preview-bitrate').value = String(settings.previewBitrate || 400000); $('record-audio').checked = Boolean(settings.audio);
  const root = $('device-controls'); root.replaceChildren();
  for (const [key, title] of Object.entries(advancedControls)) {
    const cap = caps[key]; if (cap === undefined) continue;
    const label = document.createElement('label'); label.textContent = title;
    let input;
    if (Array.isArray(cap) && cap.every(x => typeof x === 'string')) {
      input = document.createElement('select'); for (const value of cap) { const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option); }
      if (settings[key] !== undefined) input.value = settings[key];
    } else if (typeof cap === 'boolean' || Array.isArray(cap) && cap.every(x => typeof x === 'boolean')) {
      if (cap === false) continue;
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(settings[key]);
    } else if (typeof cap === 'object' && Number.isFinite(cap.min) && Number.isFinite(cap.max)) {
      input = document.createElement('input'); input.type = 'number'; input.min = cap.min; input.max = cap.max; input.step = cap.step || 'any'; input.value = settings[key] ?? cap.min;
    } else continue;
    input.dataset.constraint = key; label.append(input); root.append(label);
  }
  $('apply-camera').disabled = Boolean(currentTake?.active || recording.active || !p?.camera);
}
async function applyCameraConfig(config) {
  if (!stream || recording.active) return;
  armed = false;
  const track = stream.getVideoTracks()[0], previous = track.getConstraints(), caps = track.getCapabilities?.() || {};
  try {
    const { width, height, fps, bitrate, previewBitrate, audio } = config;
    if (![width, height, fps, bitrate, previewBitrate].every(Number.isFinite) || width < 160 || width > 7680 || height < 120 || height > 4320 || fps < 1 || fps > 120 || bitrate < 100000 || bitrate > 50000000 || previewBitrate < 100000 || previewBitrate > 5000000) throw Error('Giá trị cấu hình ngoài phạm vi cho phép.');
    const advanced = {};
    for (const [key, value] of Object.entries(config.advanced || {})) {
      const cap = caps[key]; if (!(key in advancedControls) || cap === undefined) throw Error(`Camera không hỗ trợ ${key}.`);
      if (Array.isArray(cap) && !cap.includes(value)) throw Error(`Giá trị ${key} không hợp lệ.`);
      if (cap && typeof cap === 'object' && !Array.isArray(cap) && (!Number.isFinite(value) || value < cap.min || value > cap.max)) throw Error(`${key} nằm ngoài khả năng thiết bị.`);
      advanced[key] = value;
    }
    const portrait = (track.getSettings().height || 0) > (track.getSettings().width || 0);
    await track.applyConstraints({ width: { exact: portrait ? height : width }, height: { exact: portrait ? width : height }, frameRate: { ideal: fps, max: fps }, ...(Object.keys(advanced).length ? { advanced: [advanced] } : {}) });
    cameraOptions = { bitrate, previewBitrate, audio: Boolean(audio) };
    if (!cameraOptions.audio) for (const audioTrack of stream.getAudioTracks()) { stream.removeTrack(audioTrack); audioTrack.stop(); }
    await Promise.allSettled([...mesh.outgoing.values()].map(pc => mesh.applyPreview(pc)));
    await publishCamera(); message('Đã áp dụng cấu hình. Bấm “Sẵn sàng quay” trên điện thoại này trước lượt quay tiếp theo.');
  } catch (error) {
    try { await track.applyConstraints(previous); } catch {}
    await publishCamera(error.message); message(`Không áp dụng được cấu hình: ${error.message}`);
  }
}
function updateRecordingUI() {
  if (!me) return;
  const owner = hostId === me.id, cameras = [me, ...peers.values()].filter(p => p.role === 'camera');
  $('arm').hidden = me.role !== 'camera'; $('arm').disabled = recording.active || paused;
  $('arm').textContent = armed ? '✓ Máy này sẵn sàng' : 'Sẵn sàng quay trên máy này';
  $('video-permissions').textContent = owner ? 'Bạn là admin: chỉ bạn được tải hoặc xóa. Bắt đầu lượt mới sẽ xóa vĩnh viễn toàn bộ video cũ của phòng.' : 'Chỉ chủ phòng (admin) được tải hoặc xóa video. Phòng chỉ giữ lượt quay mới nhất.';
  $('record-all').disabled = !owner || Boolean(currentTake?.active) || !storageReady || !cameras.length || cameras.some(p => !p.camera?.ready);
  $('stop-all').disabled = !owner || !currentTake?.active;
  $('apply-camera').disabled = Boolean(currentTake?.active || recording.active);
  document.querySelector('.record-panel').classList.toggle('is-recording', Boolean(currentTake?.active));
  clearInterval(takeTimer);
  function timer() {
    if (currentTake?.preparing) { $('take-status').textContent = 'Đang xóa lượt cũ và chuẩn bị lượt mới…'; return; }
    if (currentTake?.active) {
      const seconds = (Date.now() + clockOffset - currentTake.scheduledAt) / 1000;
      $('take-status').textContent = seconds < 0 ? `Bắt đầu sau ${Math.ceil(-seconds)} giây…` : `● Đang quay · ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    } else $('take-status').textContent = currentTake ? 'Đã dừng · Đang lưu từng video' : `${cameras.filter(p => p.camera?.ready).length}/${cameras.length} camera sẵn sàng${owner ? ' · Bạn là admin của phòng' : ' · Chủ phòng điều khiển quay'}`;
  }
  timer(); if (currentTake?.active) takeTimer = setInterval(timer, 250);
  if (!storageReady) $('cloud-status').textContent = 'Chưa cấu hình Neon Object Storage trên server. Quay chung sẽ bật sau khi cấu hình xong.';
  else if ($('cloud-status').textContent.includes('kiểm tra')) $('cloud-status').textContent = 'Neon Object Storage đã cấu hình · Camera ghi riêng, xem trước không thu âm';
  for (const p of cameras) {
    const card = document.getElementById(`cam-${p.id}`);
    const job = [...roomVideos.values()].find(job => job.take === currentTake?.id && job.peerId === p.id);
    if (card) card.querySelector('.cam-rec').textContent = currentTake?.active && job?.captureState === 'recording' ? '● Đang ghi trên máy' : p.camera?.ready ? '✓ Sẵn sàng quay' : p.camera?.error || (recording.active && p.id === me.id ? '● Đang ghi trên máy' : 'Chờ máy bấm Sẵn sàng');
  }
  renderRoomVideos();
}
function renderRoomVideos() {
  const root = $('room-recordings'); root.replaceChildren();
  if (currentTake && !currentTake.active) {
    const clips = [...roomVideos.values()].filter(job => job.take === currentTake.id), uploaded = clips.filter(job => job.state === 'uploaded').length;
    $('take-status').textContent = uploaded === currentTake.cameraIds.length ? `Đã lưu ${uploaded}/${currentTake.cameraIds.length} video lên Neon` : `Đã dừng · ${uploaded}/${currentTake.cameraIds.length} video đã lưu Neon`;
  }
  const stateLabels = { scheduled: 'Đếm ngược', receiving: 'Đang nhận dữ liệu', uploading: 'Đang lưu Neon', uploaded: 'Đã lưu Neon', 'upload-failed': 'Lỗi upload · thử lại trên máy quay' };
  for (const job of [...roomVideos.values()].reverse()) {
    const row = document.createElement('div'); row.className = 'room-recording';
    const text = document.createElement('span');
    text.textContent = `${job.name} · CAM ${job.slot} · ${job.take} · ${job.captureState === 'failed' ? `Lỗi ghi: ${job.captureError}` : stateLabels[job.state] || job.state} · ${(job.bytes / 1048576).toFixed(1)} MB${job.capture?.width ? ` · ${job.capture.width}×${job.capture.height} · ${(job.capture.encoderBitrate / 1000000).toFixed(1)} Mbps` : ''}`;
    row.append(text);
    if (hostId === me?.id && job.state === 'uploaded') {
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Tải video Neon';
      button.onclick = async () => { try { const { url } = await api('record/download', { id: job.id }); const link = document.createElement('a'); link.href = url; link.rel = 'noreferrer'; link.click(); } catch (e) { message(e.message); } };
      row.append(button);
    }
    if (hostId === me?.id) {
      const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Xóa video';
      remove.disabled = Boolean(currentTake?.active);
      remove.onclick = async () => {
        if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = 'Bấm lần nữa để xóa vĩnh viễn'; return; }
        remove.disabled = true;
        try { await api('record/delete', { id: job.id }); roomVideos.delete(job.id); renderRoomVideos(); }
        catch (error) { message(error.message); remove.disabled = false; }
      }; row.append(remove);
    }
    root.append(row);
  }
}
$('arm').onclick = async () => {
  if (!stream || !me || recording.active) return;
  try {
    if (!supportedMime()) throw Error('Trình duyệt này không hỗ trợ ghi video. Thử Chrome hoặc Safari bản mới.');
    if (cameraOptions.audio && !stream.getAudioTracks().some(t => t.readyState === 'live')) {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      for (const track of audio.getAudioTracks()) stream.addTrack(track);
    }
    await navigator.storage?.persist?.();
    armed = true; await publishCamera(); updateRecordingUI(); message('Máy này sẵn sàng. Giữ trang mở và chờ chủ phòng bấm quay.');
  } catch (e) { armed = false; await publishCamera(e.message); message(e.message); }
};
$('config-target').onchange = () => renderSettings($('config-target').value);
$('camera-config-form').onsubmit = async e => {
  e.preventDefault();
  const [width, height] = $('resolution').value.split('x').map(Number), advanced = {};
  for (const input of $('device-controls').querySelectorAll('[data-constraint]')) advanced[input.dataset.constraint] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  try { await api('camera-config', { id: $('config-target').value, config: { width, height, fps: Number($('fps').value), bitrate: Number($('record-bitrate').value), previewBitrate: Number($('preview-bitrate').value), audio: $('record-audio').checked, advanced } }); }
  catch (error) { message(error.message); }
};
$('record-all').onclick = async () => { $('record-all').disabled = true; try { await api('record/start', {}); } catch (e) { message(e.message); updateRecordingUI(); } };
$('stop-all').onclick = async () => { $('stop-all').disabled = true; try { await api('record/stop', {}); } catch (e) { message(e.message); updateRecordingUI(); } };
const recoverConnections = () => { if (mesh) for (const peer of peers.values()) mesh.reconnect(peer.id); };
window.addEventListener('online', recoverConnections);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && mesh) {
  for (const [other, pc] of mesh.incoming) if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') mesh.reconnect(other);
} });
