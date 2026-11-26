/**
 * 抽屜內的任務切換（相關任務、複製任務）：
 * - jumpToTask(from, to)：以 push 切換 ?task（瀏覽器上一頁可回到原任務），並記住來源供「返回」按鈕使用
 * - openDuplicated(id)：複製完成後切換到新任務，並要求新面板聚焦標題
 */
import { TASK_PARAM } from '../../lib/openTask.js';
import { navigateTo } from '../../lib/navigation.js';

let back = null;
let titleFocus = null;

function urlWithTask(id) {
  const url = new URL(window.location.href);
  url.searchParams.set(TASK_PARAM, String(id));
  return url.pathname + url.search;
}

export function jumpToTask(from, to) {
  back = { from: from.id, to, fromTitle: from.title };
  navigateTo(urlWithTask(to));
}

/** 目前任務若是由相關任務跳轉而來，回傳來源（供「返回」） */
export function backTargetFor(id) {
  return back && back.to === id ? { id: back.from, title: back.fromTitle } : null;
}

export function goBackFrom(id) {
  const target = backTargetFor(id);
  back = null;
  if (!target) return;
  // 由 jumpToTask push 而來：用瀏覽器上一頁，保持歷史紀錄一致
  window.history.back();
}

export function openDuplicated(id) {
  titleFocus = id;
  back = null;
  navigateTo(urlWithTask(id));
}

/** 新面板掛載時呼叫：是否需要聚焦標題（只取一次） */
export function consumeTitleFocus(id) {
  if (titleFocus !== id) return false;
  titleFocus = null;
  return true;
}
