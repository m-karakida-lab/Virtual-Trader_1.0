// ファイルを開いたフォルダの履歴（File System Access API、Chrome/Edgeのみ対応）。
// 明示的な「フォルダ登録」操作は無く、フォルダ経由でファイルを開くたびに自動で履歴に積む。
//
// showOpenFilePicker（ファイルを直接選ぶダイアログ）の戻り値にはフォルダの情報が一切
// 含まれず、親フォルダをたどるAPIも存在しない。フォルダ名を得るには実際に
// showDirectoryPicker（フォルダを選ぶダイアログ）を経由するしかないため、履歴に載る
// エントリは常に「フォルダを開く...」経由のものだけになる（「ファイルを開く...」で
// 直接ファイルを選んだ場合は履歴に残らない。これは仕様上の制約であり省略ではない）

const DB_NAME = 'virtual-trader';
const STORE_NAME = 'handles';
const KEY = 'open-history';
const MAX_HISTORY = 12;

export interface OpenHistoryEntry {
  handle: FileSystemDirectoryHandle;
  label: string; // フォルダ名（File System Access APIは絶対パスを渡さないためこれ止まり）
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
  const w = window as unknown as { showOpenFilePicker?: unknown; showDirectoryPicker?: unknown };
  return typeof w.showOpenFilePicker === 'function' && typeof w.showDirectoryPicker === 'function';
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

type ComparableHandle = FileSystemDirectoryHandle & { isSameEntry: (other: FileSystemHandle) => Promise<boolean> };

// 同じフォルダの履歴が既にあれば消してから先頭に積み直す（最近使った順を保つ）
export async function addToHistory(handle: FileSystemDirectoryHandle): Promise<OpenHistoryEntry[]> {
  const existing = await loadOpenHistory();
  const filtered: OpenHistoryEntry[] = [];
  for (const e of existing) {
    if (!(await (e.handle as ComparableHandle).isSameEntry(handle))) filtered.push(e);
  }
  const next = [{ handle, label: handle.name, timestamp: Date.now() }, ...filtered].slice(0, MAX_HISTORY);
  await saveOpenHistory(next);
  return next;
}

const CSV_PICKER_TYPES = [{ description: 'CSV / VTD', accept: { 'text/csv': ['.csv', '.vtd'] } }];

// フォルダを選ぶダイアログ。キャンセル（AbortError）時はnull
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  try {
    return await picker();
  } catch {
    return null;
  }
}

// ファイルを直接選ぶダイアログ。startInを渡すとそのフォルダを初期位置にする
// （ハンドルが古くて解決できない場合はブラウザ側が黙って既定位置にフォールバックする）。
// キャンセル（AbortError）時はnull。ハンドルも一緒に返す（単一ファイル選択時の
// 上書き保存＝saveChartFileでcreateWritableするために使う）
export async function pickFiles(startIn?: FileSystemDirectoryHandle): Promise<{ files: File[]; handles: FileSystemFileHandle[] } | null> {
  const picker = (window as unknown as {
    showOpenFilePicker: (opts: {
      multiple: boolean;
      types: typeof CSV_PICKER_TYPES;
      startIn?: FileSystemDirectoryHandle;
    }) => Promise<FileSystemFileHandle[]>;
  }).showOpenFilePicker;
  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({ multiple: true, types: CSV_PICKER_TYPES, ...(startIn ? { startIn } : {}) });
  } catch {
    return null;
  }
  const files = await Promise.all(handles.map(h => h.getFile()));
  return { files, handles };
}

type WritableFileHandle = FileSystemFileHandle & {
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
};

// 選択済みのファイルハンドルへ直接書き込む（ネイティブの保存ダイアログを介さない
// 本当の上書き保存）。書き込み権限が無ければブラウザが自動でプロンプトを出す
// （createWritable自体がreadwrite権限を要求する。ユーザー操作の延長で呼ぶ必要がある）
export async function writeToHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await (handle as WritableFileHandle).createWritable();
  await writable.write(text);
  await writable.close();
}
