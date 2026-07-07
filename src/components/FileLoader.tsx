import { useEffect, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import {
  isFileSystemAccessSupported, pickAndAddFolder, loadSavedFolders, removeFolder,
  hasReadPermission, requestReadPermission, listCsvFiles,
} from '../lib/folderBookmark';

export function FileLoader() {
  const loadFiles   = useTraderStore(s => s.loadFiles);
  const isLoading   = useTraderStore(s => s.isLoading);
  const loadingMsg  = useTraderStore(s => s.loadingMsg);

  const supported = isFileSystemAccessSupported();
  const [folders, setFolders] = useState<FileSystemDirectoryHandle[]>([]);
  const [needsPermission, setNeedsPermission] = useState<Set<FileSystemDirectoryHandle>>(new Set());

  // 起動時にブックマーク済みフォルダがあれば復元を試みる（読み込みはせず、ボタンを出すだけ）
  useEffect(() => {
    if (!supported) return;
    (async () => {
      const saved = await loadSavedFolders();
      setFolders(saved);
      const needy = new Set<FileSystemDirectoryHandle>();
      for (const h of saved) {
        if (!(await hasReadPermission(h))) needy.add(h);
      }
      setNeedsPermission(needy);
    })();
  }, [supported]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadFiles(e.target.files);
    }
  };

  const loadFromFolder = async (handle: FileSystemDirectoryHandle) => {
    const csvFiles = await listCsvFiles(handle);
    if (csvFiles.length === 0) return;
    const files = await Promise.all(csvFiles.map(f => f.getFile()));
    loadFiles(files);
  };

  const addFolder = async () => {
    try {
      const handle = await pickAndAddFolder();
      if (!handle) return;
      setFolders(await loadSavedFolders());
      await loadFromFolder(handle);
    } catch {
      // ユーザーがピッカーをキャンセルした場合など
    }
  };

  const quickLoad = async (handle: FileSystemDirectoryHandle) => {
    await loadFromFolder(handle);
  };

  const grantAccess = async (handle: FileSystemDirectoryHandle) => {
    if (await requestReadPermission(handle)) {
      setNeedsPermission(prev => {
        const next = new Set(prev);
        next.delete(handle);
        return next;
      });
      await loadFromFolder(handle);
    }
  };

  const unbookmark = async (handle: FileSystemDirectoryHandle) => {
    await removeFolder(handle);
    setFolders(await loadSavedFolders());
  };

  return (
    <div style={{
      padding: '8px 12px',
      borderBottom: '1px solid #2a2a2a',
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '8px',
      backgroundColor: '#111',
    }}>
      <span style={{ color: '#555', fontSize: '14px' }}>CSV</span>
      <input
        type="file"
        accept=".csv"
        multiple
        onChange={handleChange}
        disabled={isLoading}
        style={{ color: '#888', fontSize: '14px' }}
      />
      {loadingMsg && (
        <span style={{
          color: isLoading ? '#666' : '#66bb6a',
          fontSize: '13px', fontVariantNumeric: 'tabular-nums',
        }}>
          {loadingMsg}
        </span>
      )}

      {supported && (
        <>
          <span style={{ width: '1px', height: '18px', backgroundColor: '#2a2a2a' }} />

          {folders.map((h, i) => (
            needsPermission.has(h) ? (
              <button key={h.name + i} onClick={() => grantAccess(h)} style={{
                backgroundColor: '#3a2a0d', color: '#ffb74d', border: '1px solid #5a4a1d',
                borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
              }}>🔓 {h.name}</button>
            ) : (
              <span key={h.name + i} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                <button
                  onClick={() => quickLoad(h)}
                  disabled={isLoading}
                  style={{
                    backgroundColor: '#0d47a1', color: '#fff', border: 'none',
                    borderRadius: '3px 0 0 3px', padding: '4px 10px', fontSize: '13px',
                    cursor: isLoading ? 'not-allowed' : 'pointer', fontWeight: 700,
                  }}
                >⚡ {h.name}</button>
                <button
                  onClick={() => unbookmark(h)}
                  title="ブックマーク解除"
                  disabled={isLoading}
                  style={{
                    backgroundColor: '#0d47a1', color: '#9fc0ea', border: 'none',
                    borderRadius: '0 3px 3px 0', padding: '4px 8px', fontSize: '13px',
                    cursor: isLoading ? 'not-allowed' : 'pointer', borderLeft: '1px solid #1565c0',
                  }}
                >✕</button>
              </span>
            )
          ))}

          <button
            onClick={addFolder}
            disabled={isLoading}
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
            }}
          >📁 フォルダを追加</button>
        </>
      )}
    </div>
  );
}
