// File System Access API を使ったフォルダのブックマーク（Chrome/Edge のみ対応）。
// 複数のディレクトリハンドルを配列で IndexedDB に保存し、次回以降ピッカーなしで再利用できるようにする。

const DB_NAME = 'virtual-trader';
const STORE_NAME = 'handles';
const KEY = 'csv-folders';

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
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function loadSavedFolders(): Promise<FileSystemDirectoryHandle[]> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function saveFolders(handles: FileSystemDirectoryHandle[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handles, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

type ComparableHandle = FileSystemDirectoryHandle & {
  isSameEntry: (other: FileSystemHandle) => Promise<boolean>;
};

// ピッカーで選んだフォルダをブックマーク一覧に追加（同じフォルダが既にあれば追加しない）
export async function pickAndAddFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  const handle = await picker();
  const existing = await loadSavedFolders();
  for (const h of existing) {
    if (await (h as ComparableHandle).isSameEntry(handle)) return handle;
  }
  await saveFolders([...existing, handle]);
  return handle;
}

export async function removeFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  const existing = await loadSavedFolders();
  const kept: FileSystemDirectoryHandle[] = [];
  for (const h of existing) {
    if (!(await (h as ComparableHandle).isSameEntry(handle))) kept.push(h);
  }
  await saveFolders(kept);
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission: (opts: { mode: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission: (opts: { mode: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>;
};

export async function hasReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const status = await (handle as PermissionHandle).queryPermission({ mode: 'read' });
  return status === 'granted';
}

export async function requestReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const status = await (handle as PermissionHandle).requestPermission({ mode: 'read' });
  return status === 'granted';
}

export async function listCsvFiles(handle: FileSystemDirectoryHandle): Promise<FileSystemFileHandle[]> {
  const files: FileSystemFileHandle[] = [];
  const iterable = handle as unknown as { values: () => AsyncIterable<FileSystemHandle> };
  for await (const entry of iterable.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.csv')) {
      files.push(entry as FileSystemFileHandle);
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}
