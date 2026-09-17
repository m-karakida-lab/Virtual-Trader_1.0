// エラーログを実ファイルへも追記する（Chrome/Edge限定、File System Access API）。
// errorLog.ts のlocalStorageリングバッファはブラウザのデータを消すと一緒に消えてしまい、
// 「問題が起きた時に後から調査できるように」実ファイルへも残したいという要望に対応する。
// ファイルの選択は初回だけ行えばよく、選んだハンドルはIndexedDBに保存して次回起動時も使う
// （openHistory.tsと同じ考え方だが、DBを分けて依存させない——バージョンを共有すると
// 片方の変更がもう片方のIndexedDBスキーマに影響してしまうため）。
// 肥大化防止: 書き込み前にファイルサイズを見て、上限を超えていたら末尾だけ残して切り詰める

const DB_NAME = 'virtual-trader-errorlog';
const STORE_NAME = 'handle';
const KEY = 'log-file';
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB。超えたら末尾半分だけ残して切り詰めてから追記する

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

async function loadStoredHandle(): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function saveStoredHandle(handle: FileSystemFileHandle | null): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    if (handle) tx.objectStore(STORE_NAME).put(handle, KEY);
    else tx.objectStore(STORE_NAME).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isFileSystemAccessSupported(): boolean {
  const w = window as unknown as { showSaveFilePicker?: unknown };
  return typeof w.showSaveFilePicker === 'function';
}

type PermissionCapableHandle = FileSystemFileHandle & {
  queryPermission: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
};

// 書き込み権限があるかを確認し、無ければ（前回セッションで許可したがブラウザ再起動等で
// 切れている場合）ユーザー操作を伴わないqueryPermissionでまず確認する。ダイアログが
// 必要なrequestPermissionはユーザー操作の延長でしか呼べないため、自動追記（logError経由）
// からは呼ばない——権限が無ければ黙って諦め、次にユーザーが明示的にファイルを選び直すまで待つ
async function hasWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    const h = handle as PermissionCapableHandle;
    const state = await h.queryPermission({ mode: 'readwrite' });
    return state === 'granted';
  } catch {
    return false;
  }
}

// ユーザー操作から呼ぶ（保存先を選ぶボタン等）。ダイアログでのファイル新規作成/選択と、
// その場での書き込み権限取得を兼ねる
export async function pickErrorLogFile(): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as {
    showSaveFilePicker: (opts: {
      suggestedName: string;
      types: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;
  try {
    const handle = await picker({
      suggestedName: 'virtual-trader-error-log.txt',
      types: [{ description: 'テキスト', accept: { 'text/plain': ['.txt'] } }],
    });
    await saveStoredHandle(handle);
    return handle;
  } catch {
    return null; // キャンセル
  }
}

export async function forgetErrorLogFile(): Promise<void> {
  await saveStoredHandle(null);
}

// 現在選択中のログファイル名（未選択/未対応なら null）。設定UIの表示用
export async function getErrorLogFileName(): Promise<string | null> {
  const handle = await loadStoredHandle();
  return handle?.name ?? null;
}

type WritableFileHandle = FileSystemFileHandle & {
  createWritable: (opts?: { keepExistingData?: boolean }) => Promise<{
    write: (data: { type: 'write'; position: number; data: string } | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

// 現在選択中のログファイルの中身をそのまま返す（「ログファイルを開く」用）。
// 未選択/未対応/読み込み失敗時はnull
export async function readErrorLogFileText(): Promise<string | null> {
  if (!isFileSystemAccessSupported()) return null;
  try {
    const handle = await loadStoredHandle();
    if (!handle) return null;
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

// ログファイルを空に切り詰める（「ログをクリア」用）。書き込み権限が無い場合は諦める
export async function clearErrorLogFile(): Promise<void> {
  if (!isFileSystemAccessSupported()) return;
  try {
    const handle = await loadStoredHandle();
    if (!handle) return;
    if (!(await hasWritePermission(handle))) return;
    const writable = await (handle as WritableFileHandle).createWritable();
    await writable.close();
  } catch {
    // 無視（appendErrorToLogFileと同じ方針）
  }
}

// 1エントリをログファイルへ追記する。毎回ファイル全体を読み直さず、現在サイズを取得して
// その末尾へ書き足すだけ（File System Access APIに真の追記モードは無いため、位置指定書込みで代用）。
// 上限を超えていたら先に切り詰めてから追記する。権限が無い・未対応ブラウザ等は静かに諦める
// （エラーログ機能自体がエラーになって元のエラーが埋もれるような事態を避けるため、例外を投げない）
export async function appendErrorToLogFile(line: string): Promise<void> {
  if (!isFileSystemAccessSupported()) return;
  try {
    const handle = await loadStoredHandle();
    if (!handle) return;
    if (!(await hasWritePermission(handle))) return;

    const file = await handle.getFile();
    let startPosition = file.size;

    if (file.size > MAX_LOG_BYTES) {
      // 上限超過: 末尾半分だけ残して切り詰めてから追記する（古いログの自動削除）
      const tailStart = Math.floor(file.size / 2);
      const tailText = await file.slice(tailStart).text();
      // 行の途中から始まらないよう、最初の改行までは読み捨てる
      const firstNewline = tailText.indexOf('\n');
      const trimmed = firstNewline === -1 ? tailText : tailText.slice(firstNewline + 1);
      const writable = await (handle as WritableFileHandle).createWritable(); // keepExistingDataなし=既存を破棄して新規書き込み
      await writable.write(trimmed);
      await writable.close();
      startPosition = trimmed.length;
    }

    const writable = await (handle as WritableFileHandle).createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: startPosition, data: line });
    await writable.close();
  } catch {
    // 権限ダイアログを出せない文脈・ファイルが移動/削除された等。エラーログの副作用で
    // アプリ本体を止めたくないため、ここでは無視する
  }
}
