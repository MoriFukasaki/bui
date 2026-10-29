const $ = id => document.getElementById(id);
let csrf = '', cursor = '', loading = false;
const labels = { scheduled: 'Đã tạo lượt quay', receiving: 'Đang nhận dữ liệu', uploading: 'Đang lưu Neon', uploaded: 'Đã lưu Neon', 'upload-failed': 'Lỗi tải lên' };
async function request(path, data) {
  const response = await fetch(`/api/admin/${path}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw Error(value.error || 'Yêu cầu thất bại.'); }
  return value;
}
function showLogin() { csrf = ''; $('admin-login').hidden = false; $('admin-library').hidden = true; $('admin-videos').replaceChildren(); }
async function signedIn(value) {
  csrf = value.csrf; $('admin-identity').textContent = `ĐĂNG NHẬP: ${value.username}`;
  $('password').value = ''; $('admin-login').hidden = true; $('admin-library').hidden = false;
  await load(true);
}
async function load(reset = false) {
  if (loading) return; loading = true; $('admin-message').textContent = 'Đang tải danh sách…';
  try {
    if (reset) { cursor = ''; $('admin-videos').replaceChildren(); }
    const query = new URLSearchParams({ room: $('filter-room').value.trim().toUpperCase(), state: $('filter-state').value, before: cursor });
    const value = await request(`recordings?${query}`);
    for (const job of value.recordings) {
      const row = document.createElement('article'); row.className = 'room-recording';
      const text = document.createElement('span'), capture = job.capture || job.settings || {};
      const bitrate = job.capture?.encoderBitrate;
      text.textContent = `${Number.isFinite(job.createdAt) ? new Date(job.createdAt).toLocaleString('vi-VN') : 'Bản ghi cũ'} · Phòng ${job.room} · ${job.name || 'Chưa có tên máy'} · CAM ${job.slot || '—'} · Lượt ${job.take || '—'} · ${labels[job.state] || 'Thiếu thông tin trạng thái'} · ${((job.bytes || 0) / 1048576).toFixed(1)} MB${capture.width ? ` · ${capture.width}×${capture.height} / ${Math.round(capture.frameRate || 0)} fps` : ''}${bitrate ? ` · ${(bitrate / 1000000).toFixed(1)} Mbps` : ''}${job.captureError ? ` · Lỗi ghi: ${job.captureError}` : ''}${job.error ? ` · ${job.error}` : ''}`;
      row.append(text);
      if (job.state === 'uploaded') {
        const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Tải video gốc';
        button.onclick = async () => { button.disabled = true; try { const { url } = await request('download', { id: job.id }); const link = document.createElement('a'); link.href = url; link.rel = 'noreferrer'; link.click(); } catch (error) { $('admin-message').textContent = error.message; } finally { button.disabled = false; } };
        row.append(button);
      }
      $('admin-videos').append(row);
    }
    cursor = value.next || ''; $('load-more').hidden = !cursor;
    $('admin-message').textContent = $('admin-videos').childElementCount ? `Đang hiển thị ${$('admin-videos').childElementCount} video.` : 'Chưa có video phù hợp.';
  } catch (error) { $('admin-message').textContent = error.message; }
  finally { loading = false; }
}
$('login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { await signedIn(await request('login', { username: $('username').value, password: $('password').value })); }
  catch (error) { $('admin-message').textContent = error.message; } finally { button.disabled = false; }
};
$('filter-form').onsubmit = event => { event.preventDefault(); load(true); };
$('load-more').onclick = () => load();
$('logout').onclick = async () => { try { await request('logout', {}); showLogin(); $('admin-message').textContent = 'Đã đăng xuất.'; } catch (error) { $('admin-message').textContent = error.message; } };
request('session').then(signedIn).catch(() => {});
