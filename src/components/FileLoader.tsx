import { useEffect, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import {
  isFileSystemAccessSupported, pickAndSaveFolder, loadSavedFolder,
  hasReadPermission, requestReadPermission, listCsvFiles,
} from '../lib/folderBookmark';

export function FileLoader() {
  const loadFiles   = useTraderStore(s => s.loadFiles);
  const isLoading   = useTraderStore(s => s.isLoading);
  const loadingMsg  = useTraderStore(s => s.loadingMsg);

  const supported = isFileSystemAccessSupported();
  const [folderHandle, setFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);

  // 起動時にブックマーク済みフォルダがあれば復元を試みる（読み込みはせず、ボタンを出すだけ）
  useEffect(() => {
    if (!supported) return;
    (async () => {
      const handle = await loadSavedFolder();
      if (!handle) return;
      setFolderHandle(handle);
      setNeedsPermission(!(await hasReadPermission(handle)));
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

  const pickFolder = async () => {
    try {
      const handle = await pickAndSaveFolder();
      if (!handle) return;
      setFolderHandle(handle);
      setNeedsPermission(false);
      await loadFromFolder(handle);
    } catch {
      // ユーザーがピッカーをキャンセルした場合など
    }
  };

  const quickLoad = async () => {
    if (!folderHandle) return;
    await loadFromFolder(folderHandle);
  };

  const grantAccess = async () => {
    if (!folderHandle) return;
    if (await requestReadPermission(folderHandle)) {
      setNeedsPermission(false);
      await loadFromFolder(folderHandle);
    }
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

          {folderHandle && !needsPermission && (
            <button
              onClick={quickLoad}
              disabled={isLoading}
              style={{
                backgroundColor: '#0d47a1', color: '#fff', border: 'none',
                borderRadius: '3px', padding: '4px 10px', fontSize: '13px',
                cursor: isLoading ? 'not-allowed' : 'pointer', fontWeight: 700,
              }}
            >⚡ {folderHandle.name} から読み込む</button>
          )}

          {needsPermission && (
            <button onClick={grantAccess} style={{
              backgroundColor: '#3a2a0d', color: '#ffb74d', border: '1px solid #5a4a1d',
              borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
            }}>🔓 アクセスを許可</button>
          )}

          <button
            onClick={pickFolder}
            disabled={isLoading}
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
            }}
          >📁 {folderHandle ? 'フォルダを変更' : 'フォルダを記憶'}</button>
        </>
      )}
    </div>
  );
}
