// 全域樣式必須最先載入：Tailwind 的 @layer 順序宣告要排在任何 feature CSS 之前，
// 否則 feature CSS 會被打包到前面，造成 cascade layer 順序錯亂。
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
