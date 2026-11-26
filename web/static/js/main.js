// 前端入口：由 web/index.html 以 <script type="module"> 載入；沒有建置步驟。
// 全域樣式在 index.html 以 <link> 載入（layer 順序宣告在 css/base.css）。
import { createElement, render } from 'preact';
import { App } from './App.js';

render(createElement(App), document.getElementById('root'));
