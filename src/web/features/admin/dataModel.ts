import type {
  ConflictResolution,
  ImportConflict,
  ImportPreview,
  ImportResult,
  ImportStrategy,
} from '../../../shared/dataTransfer.ts';

export const STRATEGY_LABELS: Record<ImportStrategy, string> = {
  keep_newer: '以較新者為準',
  keep_local: '保留本機',
  use_import: '使用匯入檔',
};

export const RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  keep_local: '保留本機',
  use_import: '使用匯入檔',
};

export const NEWER_LABELS: Record<ImportConflict['newer'], string> = {
  local: '本機較新',
  import: '匯入檔較新',
  same: '更新時間相同',
};

/** 單筆衝突實際採用的處理：逐筆覆寫優先，否則依全域策略（keep_newer 同時間時保留本機） */
export function effectiveResolution(
  strategy: ImportStrategy,
  override: ConflictResolution | undefined,
  newer: ImportConflict['newer'],
): ConflictResolution {
  if (override) return override;
  if (strategy === 'keep_newer') return newer === 'import' ? 'use_import' : 'keep_local';
  return strategy;
}

/** 依目前策略與覆寫，統計會採用匯入檔的衝突筆數 */
export function countUseImport(
  conflicts: readonly ImportConflict[],
  strategy: ImportStrategy,
  overrides: Readonly<Record<string, ConflictResolution>>,
): number {
  return conflicts.filter((c) => effectiveResolution(strategy, overrides[c.key], c.newer) === 'use_import')
    .length;
}

/** 差異欄位值的顯示文字 */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function totalNew(p: ImportPreview): number {
  return p.categories.reduce((n, c) => n + c.new, 0);
}

export function resultTotals(r: ImportResult) {
  return r.categories.reduce(
    (t, c) => ({
      created: t.created + c.created,
      updated: t.updated + c.updated,
      deleted: t.deleted + c.deleted,
      skipped: t.skipped + c.skipped,
    }),
    { created: 0, updated: 0, deleted: 0, skipped: 0 },
  );
}

/** 讀取使用者選的檔案並解析 JSON（失敗時丟出可顯示的訊息） */
export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('檔案不是有效的 JSON');
  }
}
