// File System Access API を使ったフォルダのブックマーク（Chrome/Edge のみ対応）。
// ディレクトリハンドルを IndexedDB に保存し、次回以降ピッカーなしで同じフォルダを再利用できるようにする。

const DB_NAME = 'virtual-trader';
const STORE_NAME = 'handles';
const KEY = 'csv-folder';

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

export async function pickAndSaveFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  const handle = await picker();
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return handle;
}

export async function loadSavedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
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
