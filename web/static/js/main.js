// 前端入口：由 web/index.html 以 <script type="module"> 載入；沒有建置步驟。
// 全域樣式在 index.html 以 <link> 載入（layer 順序宣告在 css/base.css）。
import { createElement, options, render } from 'preact';
import { App } from './App.js';

// useEffect 的時機對齊 React：Preact 預設等「下一個畫面 frame 之後」才跑 useEffect，
// React 則會在下一個使用者事件之前先把 effect 沖掉。程式裡很多「開啟面板就把焦點移進去」是寫在 useEffect 裡的，
// 使用者（或 E2E）若在 frame 之前就按下一個鍵，焦點還沒移、鍵就落到舊地方（例如 Esc 關掉整個對話框）。
// 改成 microtask：render 一結束就跑 effect，之後的任何事件都看得到 effect 的結果。
options.requestAnimationFrame = (cb) => queueMicrotask(cb);

render(createElement(App), document.getElementById('root'));
