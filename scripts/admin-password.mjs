import { hashPassword } from '../admin.mjs';
if (!process.stdin.isTTY) throw Error('Chạy lệnh này trong terminal tương tác để nhập mật khẩu ẩn.');
process.stdout.write('Mật khẩu admin mới (tối thiểu 12 ký tự, nhập ẩn): ');
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
let password = '';
process.stdin.on('data', async text => {
  for (const char of text) {
    if (char === '\u0003') { process.stdin.setRawMode(false); process.exit(1); }
    if (char === '\r' || char === '\n') {
      process.stdin.setRawMode(false); process.stdin.pause();
      try { console.log(`\nADMIN_PASSWORD_HASH=${await hashPassword(password)}`); }
      catch (error) { console.error(`\n${error.message}`); process.exitCode = 1; }
      password = ''; return;
    }
    if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
    else if (password.length < 256 && char >= ' ') password += char;
  }
});
