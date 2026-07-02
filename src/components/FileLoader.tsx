import { useEffect, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import {
  isFileSystemAccessSupported, pickAndSaveFolder, loadSavedFolder,
  hasReadPermission, requestReadPermission, listCsvFiles,
} from '../lib/folderBookmark';

const chipStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center',
  backgroundColor: active ? '#1565c0' : '#1a1a1a',
  color: active ? '#fff' : '#888',
  border: `1px solid ${active ? '#1976d2' : '#2a2a2a'}`,
  borderRadius: '3px', padding: '4px 10px', fontSize: '13px',
  cursor: 'pointer', whiteSpace: 'nowrap',
});

export function FileLoader() {
  const loadFiles   = useTraderStore(s => s.loadFiles);
  const isLoading   = useTraderStore(s => s.isLoading);
  const loadingMsg  = useTraderStore(s => s.loadingMsg);

  const supported = isFileSystemAccessSupported();
  const [folderHandle, setFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [csvFiles, setCsvFiles] = useState<FileSystemFileHandle[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 起動時にブックマーク済みフォルダがあれば復元を試みる
  useEffect(() => {
    if (!supported) return;
    (async () => {
      const handle = await loadSavedFolder();
      if (!handle) return;
      setFolderHandle(handle);
      if (await hasReadPermission(handle)) {
        setCsvFiles(await listCsvFiles(handle));
      } else {
        setNeedsPermission(true);
      }
    })();
  }, [supported]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadFiles(e.target.files);
    }
  };

  const pickFolder = async () => {
    try {
      const handle = await pickAndSaveFolder();
      if (!handle) return;
      setFolderHandle(handle);
      setNeedsPermission(false);
      setSelected(new Set());
      setCsvFiles(await listCsvFiles(handle));
    } catch {
      // ユーザーがピッカーをキャンセルした場合など
    }
  };

  const grantAccess = async () => {
    if (!folderHandle) return;
    if (await requestReadPermission(folderHandle)) {
      setNeedsPermission(false);
      setCsvFiles(await listCsvFiles(folderHandle));
    }
  };

  const toggleSelect = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const loadSelected = async () => {
    const targets = csvFiles.filter(f => selected.has(f.name));
    if (targets.length === 0) return;
    const files = await Promise.all(targets.map(f => f.getFile()));
    loadFiles(files);
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
      {isLoading && (
        <span style={{ color: '#666', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
          {loadingMsg}
        </span>
      )}

      {supported && (
        <>
          <span style={{ width: '1px', height: '18px', backgroundColor: '#2a2a2a' }} />
          <button
            onClick={pickFolder}
            disabled={isLoading}
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
            }}
          >📁 {folderHandle ? 'フォルダを変更' : 'フォルダを記憶'}</button>

          {needsPermission && (
            <button onClick={grantAccess} style={{
              backgroundColor: '#3a2a0d', color: '#ffb74d', border: '1px solid #5a4a1d',
              borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
            }}>🔓 アクセスを許可</button>
          )}

          {csvFiles.length > 0 && (
            <>
              {csvFiles.map(f => (
                <span
                  key={f.name}
                  onClick={() => toggleSelect(f.name)}
                  style={chipStyle(selected.has(f.name))}
                >{f.name}</span>
              ))}
              <button
                onClick={loadSelected}
                disabled={selected.size === 0 || isLoading}
                style={{
                  backgroundColor: selected.size === 0 ? '#1a1a1a' : '#0d47a1',
                  color: selected.size === 0 ? '#444' : '#fff',
                  border: 'none', borderRadius: '3px', padding: '5px 12px', fontSize: '13px',
                  cursor: selected.size === 0 ? 'not-allowed' : 'pointer', fontWeight: 700,
                }}
              >選択した{selected.size}件を読み込む</button>
            </>
          )}
        </>
      )}
    </div>
  );
}
