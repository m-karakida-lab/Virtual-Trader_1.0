import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { logError } from './lib/errorLog';
import './index.css';

// レンダーツリー外（イベントハンドラ・非同期処理）で起きた例外も記録する。
// ErrorBoundary はレンダー/エフェクト中の例外のみ捕捉するため、両方揃えて初めて
// 「原因不明の黒画面」系の不具合を後から追跡できる
window.addEventListener('error', e => logError('window.onerror', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => logError('unhandledrejection', e.reason));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
