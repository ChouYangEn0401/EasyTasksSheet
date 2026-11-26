import { useEffect, useState } from 'preact/hooks';
import { apiUrl } from './base.js';

/**
 * 版本與署名（來源：/api/health → server/app/version.py）。整個分頁只抓一次。
 * 抓不到時顯示空字串，不影響任何功能。
 */
let cached = null;
let inflight = null;

export function fetchAppInfo() {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch(apiUrl('/health'), { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        cached = j
          ? { app: j.app ?? 'EasyTasksSheet', version: j.version ?? '', author: j.author ?? '', repository: j.repository ?? '' }
          : { app: 'EasyTasksSheet', version: '', author: '', repository: '' };
        return cached;
      })
      .catch(() => (cached = { app: 'EasyTasksSheet', version: '', author: '', repository: '' }));
  }
  return inflight;
}

export function useAppInfo() {
  const [info, setInfo] = useState(cached);
  useEffect(() => {
    let alive = true;
    void fetchAppInfo().then((v) => alive && setInfo(v));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
