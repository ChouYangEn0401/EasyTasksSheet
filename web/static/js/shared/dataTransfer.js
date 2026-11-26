// 資料管理（feat/data-export）：/api/admin/data/* 的輸入與回應格式（後端見 server/app/data_transfer.py）

export const IMPORT_STRATEGIES = ['keep_newer', 'keep_local', 'use_import'];
/** 衝突的全域處理策略：以 updatedAt 較新者為準（預設）/ 保留本機 / 使用匯入檔 */

/** 單筆衝突的處理（逐筆覆寫） */

/** 匯入檔中的成員在本機不存在時：略過指派 / 自動建立（一般成員、臨時密碼） */

/** 取代模式需輸入的確認字樣（與後端 REPLACE_CONFIRM 一致） */
export const REPLACE_CONFIRM_TEXT = '取代全部資料';
