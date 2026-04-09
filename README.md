# Focus Your Time

Extension Chrome giúp theo dõi **thời gian duyệt web theo từng domain** trong ngày để bạn nhận biết mình đang dành thời gian cho đâu.

> Mốc reset ngày được tính lúc **07:00 sáng** (thay vì 00:00).

## Mo ta

`Focus Your Time` chạy bằng Chrome Extension Manifest V3:
- Background service worker theo dõi tab/window để ghi nhận thời gian theo domain.
- Content script hiển thị overlay trực tiếp trên trang để bạn xem nhanh thời lượng.
- Du lieu duoc luu trong `chrome.storage` theo ngay logic (reset luc 07:00).

## Tinh nang chinh

- Theo doi tong thoi gian truy cap theo domain.
- Hien thi thong tin ngay tren trang web qua overlay.
- Tu dong tach ngay theo moc 07:00 sang.
- Ho tro `http` va `https`.

## Cong nghe su dung

- TypeScript
- Vite
- `@crxjs/vite-plugin` (build Chrome extension)
- Chrome Extension Manifest V3

## Cau truc thu muc

```text
src/
  background/
    service-worker.ts
  content/
    overlay.ts
    overlay.css
  shared/
    domain-from-url.ts
    format-duration.ts
    logical-day.ts
    storage.ts
manifest.json
vite.config.ts
```

## Yeu cau moi truong

- Node.js >= 18 (khuyen nghi ban LTS moi)
- npm
- Google Chrome/Chromium

## Cai dat

```bash
npm install
```

## Lenh phat trien

Chay che do development:

```bash
npm run dev
```

Build extension:

```bash
npm run build
```

Sau khi build, thu muc output la `dist/`.

## Cach cai extension vao Chrome (Load unpacked)

1. Mo Chrome va truy cap `chrome://extensions/`
2. Bat **Developer mode** (goc phai)
3. Chon **Load unpacked**
4. Chon thu muc `dist` (KHONG chon thu muc goc project)

## Cach su dung

1. Cai extension theo huong dan tren.
2. Mo cac trang web nhu binh thuong.
3. Quan sat overlay tren trang de xem tong thoi gian theo domain.

## Scripts

Trong `package.json`:
- `npm run dev`: chay Vite de phat trien
- `npm run build`: type-check + build extension
- `npm run postbuild`: in nhac nho cach load `dist` vao Chrome

## Ghi chu

- Du lieu hien tai duoc luu local trong trinh duyet.
- Neu can dong bo da thiet bi, co the mo rong sang storage/cloud o cac phien ban sau.

## License

Ban co the bo sung license phu hop cho du an (MIT, Apache-2.0, ...).
