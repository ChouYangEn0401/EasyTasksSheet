/** 與後端 server/app/attachments.py 的白名單一致（後端仍會以內容魔術數字再驗證） */
export const EXT_KIND = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  pdf: 'pdf',
  txt: 'text',
  md: 'text',
  csv: 'text',
  json: 'text',
  log: 'text',
  zip: 'archive',
  docx: 'document',
  xlsx: 'document',
  pptx: 'document',
  odt: 'document',
  ods: 'document',
  odp: 'document',
  doc: 'document',
  xls: 'document',
  ppt: 'document',
};

/** <input type="file" accept> */
export const ACCEPT = Object.keys(EXT_KIND)
  .map((e) => `.${e}`)
  .join(',');

export const DEFAULT_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  videoMaxBytes: 200 * 1024 * 1024,
  maxFiles: 10,
};

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

export function kindOfName(name) {
  return EXT_KIND[extOf(name)] ?? 'file';
}

/** 1234567 → 1.2 MB */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** 秒數 → m:ss / h:mm:ss */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** 過長檔名中間省略，保留副檔名：very-long-name…final.png */
export function middleEllipsis(name, max = 28) {
  if (name.length <= max) return name;
  const ext = extOf(name);
  const tail = Math.max(6, ext.length + 5);
  const head = max - tail - 1;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/** 前端先檢查（類型、大小、數量），省得上傳完才被拒；回傳錯誤訊息或 null */
export function checkFile(file, limits) {
  const ext = extOf(file.name);
  const kind = EXT_KIND[ext];
  if (!kind) return `不支援的檔案類型（${ext ? `.${ext}` : '無副檔名'}）`;
  if (file.size === 0) return '空檔案';
  const max = kind === 'video' ? limits.videoMaxBytes : limits.maxBytes;
  if (file.size > max) return `超過單檔上限 ${formatBytes(max)}${kind === 'video' ? '（影片）' : ''}`;
  return null;
}

/** 剪貼簿貼上的圖片常沒有檔名（image.png），補上時間讓檔名可辨識 */
export function pastedName(type, now = new Date()) {
  const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png');
  const p = (n) => String(n).padStart(2, '0');
  return `貼上的圖片-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

/** 從剪貼簿取出圖片檔（沒有則空陣列） */
export function imagesFromClipboard(data) {
  if (!data) return [];
  const out = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) {
        const name = !f.name || f.name === 'image.png' ? pastedName(f.type) : f.name;
        out.push(new File([f], name, { type: f.type }));
      }
    }
  }
  return out;
}
