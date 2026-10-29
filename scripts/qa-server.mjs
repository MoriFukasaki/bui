// Local-only browser QA: generated color cards replace physical cameras. Never used by the production server.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const media = `
const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async constraints => {
  if (!constraints.video) return originalCapture(constraints);
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext('2d'); let frame = 0;
  const paint = () => { context.fillStyle = '#234c35'; context.fillRect(0,0,1280,720); context.fillStyle = '#d5f87b'; context.font = '52px sans-serif'; context.fillText('CAMROOM · SYNTHETIC QA CAMERA',60,170); context.fillText(new Date().toISOString(),60,270); context.fillRect(60 + frame++ % 1050,400,80,80); };
  paint(); const timer = setInterval(paint, 33), stream = canvas.captureStream(30);
  stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
  return stream;
};
document.querySelector('.beta').textContent = ' / SYNTHETIC QA';
`;
http.createServer(async (req, res) => {
  if (/^\/qa-clip\/[123]$/.test(req.url)) {
    try { const file = await readFile(new URL(`../verification/camroom-cam${req.url.slice(-1)}.mp4`, import.meta.url)); res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(file); }
    catch { res.writeHead(404); return res.end(); }
  }
  if (req.url === '/qa-playback') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<title>Camroom recorded video playback proof</title><h1>3 videos downloaded from Neon</h1>' + [1,2,3].map(i => `<h2>Camera ${i}</h2><video controls muted preload="auto" width="480" src="/qa-clip/${i}"></video>`).join(''));
  }
  if (new URL(req.url, 'http://localhost').pathname === '/') {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html.replace('<script type="module"', '<script src="/qa-media.js"></script><script type="module"'));
  }
  if (req.url === '/qa-media.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(media); }
  const upstream = http.request({ host: '127.0.0.1', port: process.env.APP_PORT || 3000, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${process.env.APP_PORT || 3000}`, ...(req.headers.origin ? { origin: `http://localhost:${process.env.APP_PORT || 3000}` } : {}) } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); res.on('close', () => upstream.destroy()); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('QA upstream unavailable'); }); req.pipe(upstream);
}).listen(3001, '127.0.0.1', () => console.log('Synthetic browser QA only: http://localhost:3001'));
