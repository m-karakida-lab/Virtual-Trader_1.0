// ファイルを開いた履歴（File System Access API、Chrome/Edgeのみ対応）。
// 明示的な「フォルダ登録」操作を廃止し、ファイルを開くたびに自動で履歴に積む。
// File System Access API はセキュリティ上の理由でOSの絶対パスを一切渡さないため、
// 表示ラベルは`handle.name`（ファイル名。フォルダ名や絶対パスは取得できない）止まりになる。
// 履歴クリック時は、保存しておいたファイルハンドルを`startIn`に渡してネイティブの
// ファイル選択ダイアログをそのファイルの親フォルダを初期位置として開き直す
// （ハンドルは「開き直す起点」としてのみ使う。中身は二度と読まない）

const DB_NAME = 'virtual-trader';
const STORE_NAME = 'handles';
const KEY = 'open-history';
const MAX_HISTORY = 12;

export interface OpenHistoryEntry {
  handle: FileSystemFileHandle;
  label: string; // 代表ファイル名（複数選択時は「name 他N件」）
  timestamp: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function isFileSystemAccessSupported(): boolean {
  return typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function';
}

export async function loadOpenHistory(): Promise<OpenHistoryEntry[]> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve((req.result as OpenHistoryEntry[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function saveOpenHistory(entries: OpenHistoryEntry[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entries, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

type ComparableHandle = FileSystemFileHandle & { isSameEntry: (other: FileSystemHandle) => Promise<boolean> };

// 同じファイルの履歴が既にあれば消してから先頭に積み直す（最近使った順を保つ）
export async function addToHistory(handle: FileSystemFileHandle, label: string): Promise<OpenHistoryEntry[]> {
  const existing = await loadOpenHistory();
  const filtered: OpenHistoryEntry[] = [];
  for (const e of existing) {
    if (!(await (e.handle as ComparableHandle).isSameEntry(handle))) filtered.push(e);
  }
  const next = [{ handle, label, timestamp: Date.now() }, ...filtered].slice(0, MAX_HISTORY);
  await saveOpenHistory(next);
  return next;
}

const CSV_PICKER_TYPES = [{ description: 'CSV / VTD', accept: { 'text/csv': ['.csv', '.vtd'] } }];

// ネイティブのファイル選択ダイアログを開く。startInを渡すとそのファイルの親フォルダを
// 初期位置にする（ハンドルが古くて解決できない場合はブラウザ側が黙って既定位置にフォールバックする）。
// キャンセル（AbortError）時はnullを返す
export async function pickFiles(startIn?: FileSystemFileHandle): Promise<{ files: File[]; handles: FileSystemFileHandle[] } | null> {
  const picker = (window as unknown as {
    showOpenFilePicker: (opts: {
      multiple: boolean;
      types: typeof CSV_PICKER_TYPES;
      startIn?: FileSystemFileHandle;
    }) => Promise<FileSystemFileHandle[]>;
  }).showOpenFilePicker;
  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({ multiple: true, types: CSV_PICKER_TYPES, ...(startIn ? { startIn } : {}) });
  } catch {
    return null; // キャンセル等
  }
  const files = await Promise.all(handles.map(h => h.getFile()));
  return { files, handles };
}
