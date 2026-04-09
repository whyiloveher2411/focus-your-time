import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Nhắc cài extension đúng thư mục (tránh load nhầm project root → lỗi .ts và chrome-extension://invalid). */
function loadUnpackedHintPlugin(): Plugin {
  return {
    name: 'fyt-load-unpacked-hint',
    closeBundle() {
      const file = path.join(__dirname, 'dist', 'LOAD_UNPACKED_FROM_THIS_FOLDER.txt');
      const body = [
        'Focus Your Time — CÀI CHROME',
        '',
        '1. Mở chrome://extensions',
        '2. Bật Developer mode',
        '3. Load unpacked → chọn ĐÚNG thư mục: …/focus your time/dist',
        '',
        'KHÔNG chọn thư mục gốc project (…/focus your time).',
        'Nếu chọn nhầm, Console báo: overlay.ts, Invalid script mime type, chrome-extension://invalid/',
        '',
        'Sau khi sửa code: chạy npm run build, rồi Reload extension.',
      ].join('\n');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), loadUnpackedHintPlugin()],
});
