// 予期しないエラーを localStorage にリングバッファで記録する。
// 「原因不明の黒画面」等、再現しにくい不具合を後から追跡するための最終手段。
// 直近 MAX_ENTRIES 件だけ保持し、コンソールにもタグ付きで出力する。
// 加えて、ユーザーがログファイルの保存先を選んでいれば実ファイルへも追記する
// （errorLogFile.ts、Chrome/Edge限定）。localStorageはブラウザのデータ削除で
// 一緒に消えてしまうため、後から調査したい時のための保険

import { appendErrorToLogFile } from './errorLogFile';

const STORAGE_KEY = 'vt:errorLog';
const MAX_ENTRIES = 20;

export interface ErrorLogEntry {
  time: string; // ローカル時刻（ファイルの更新日時と比較しやすいようUTCではなくJST等の実行環境ローカル時刻で記録）
  source: string; // 発生箇所（'window.onerror' / 'unhandledrejection' / ErrorBoundary 等）
  message: string;
  stack?: string;
}

// YYYY-MM-DD HH:mm:ss.SSS 形式のローカル時刻文字列（toISOString()はUTC固定でファイルの
// 更新日時（OSがローカル時刻で表示）と見比べにくいため、ローカル時刻のまま出力する）
function formatLocalTime(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function logError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[vt:error][${source}]`, error);
  const time = formatLocalTime(new Date());
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const entries: ErrorLogEntry[] = raw ? JSON.parse(raw) : [];
    entries.push({ time, source, message, stack });
    while (entries.length > MAX_ENTRIES) entries.shift();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage が使えない場合は console 出力のみで諦める
  }
  // ファイル書き込みは非同期・ベストエフォート（失敗してもエラーログ自体の処理は止めない）
  const line = `[${time}] [${source}] ${message}${stack ? '\n' + stack : ''}\n`;
  void appendErrorToLogFile(line);
}

export function readErrorLog(): ErrorLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearErrorLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 無視
  }
}
