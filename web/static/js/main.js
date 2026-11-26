// 前端入口（階段 0 的暫時版：只確認伺服器、靜態檔與 API 都接得上；階段 1 換成完整應用程式）
const base = document.querySelector('meta[name="ts-base"]')?.content ?? '';
const root = document.getElementById('root');
root.textContent = '前端移轉中…';
fetch(`${base}/api/health`)
  .then((r) => r.json())
  .then((j) => {
    root.textContent = `前端移轉中（API 正常：${JSON.stringify(j)}）`;
  })
  .catch((e) => {
    root.textContent = `API 連不上：${e}`;
  });
