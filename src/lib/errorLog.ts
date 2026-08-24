// 予期しないエラーを localStorage にリングバッファで記録する。
// 「原因不明の黒画面」等、再現しにくい不具合を後から追跡するための最終手段。
// 直近 MAX_ENTRIES 件だけ保持し、コンソールにもタグ付きで出力する。

const STORAGE_KEY = 'vt:errorLog';
const MAX_ENTRIES = 20;

export interface ErrorLogEntry {
  time: string; // ISO
  source: string; // 発生箇所（'window.onerror' / 'unhandledrejection' / ErrorBoundary 等）
  message: string;
  stack?: string;
}

export function logError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[vt:error][${source}]`, error);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const entries: ErrorLogEntry[] = raw ? JSON.parse(raw) : [];
    entries.push({ time: new Date().toISOString(), source, message, stack });
    while (entries.length > MAX_ENTRIES) entries.shift();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage が使えない場合は console 出力のみで諦める
  }
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
