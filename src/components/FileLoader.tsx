import { useEffect, useRef, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import {
  isFileSystemAccessSupported, loadOpenHistory, addToHistory, pickFolder, pickFiles, type OpenHistoryEntry,
} from '../lib/openHistory';

// クリックで開閉するドロップダウン（下方向に開く。Controls.tsxのMenuButtonと似ているが
// あちらは下部バー用に上方向へ開くため、開く向きだけ違う専用の実装を持つ）
function OpenMenuButton({
  label, disabled, children,
}: {
  label: string; disabled: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        style={{
          backgroundColor: '#e0e0e0', color: '#111', border: 'none', borderRadius: '3px',
          padding: '4px 10px', fontSize: '14px', fontWeight: 700,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        }}
      >{label} {open ? '▴' : '▾'}</button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0,
            backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60,
            minWidth: '260px', maxWidth: '90vw', overflow: 'hidden',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function FileLoader() {
  const loadFiles   = useTraderStore(s => s.loadFiles);
  const isLoading   = useTraderStore(s => s.isLoading);
  const loadingMsg  = useTraderStore(s => s.loadingMsg);
  const saveChartFile = useTraderStore(s => s.saveChartFile);
  const canSave     = useTraderStore(s => s.rawCsvText !== null);
  const canOverwrite = useTraderStore(s => s.rawFileHandle !== null);
  const loadedFileLabel = useTraderStore(s => s.loadedFileLabel);

  const supported = isFileSystemAccessSupported();
  const [history, setHistory] = useState<OpenHistoryEntry[]>([]);

  useEffect(() => {
    if (!supported) return;
    loadOpenHistory().then(setHistory);
  }, [supported]);

  // File System Access API 非対応ブラウザ（Safari/Firefox）向けのフォールバック。
  // 履歴は持てないため素の<input type=file>で選ぶだけ
  const handleFallbackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadFiles(e.target.files);
    }
  };

  // ファイルを直接選ぶ（フォルダ情報が取れないため履歴には残らない）。
  // 単一ファイル選択時はそのファイルハンドルも渡す（vtd保存で上書きに使うため）
  const openFilesDirect = async () => {
    const result = await pickFiles();
    if (result === null || result.files.length === 0) return;
    loadFiles(result.files, result.files.length === 1 ? result.handles[0] : undefined);
  };

  // フォルダを選んでから、そのフォルダを初期位置にファイル選択ダイアログを開く。
  // 履歴クリック時（startIn指定あり）は最初のフォルダ選択をスキップして直接ファイル選択へ
  const openViaFolder = async (folder?: FileSystemDirectoryHandle) => {
    const dir = folder ?? await pickFolder();
    if (dir === null) return; // キャンセル
    const result = await pickFiles(dir);
    if (result === null || result.files.length === 0) return;
    loadFiles(result.files, result.files.length === 1 ? result.handles[0] : undefined);
    const next = await addToHistory(dir);
    setHistory(next);
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

      {supported ? (
        <OpenMenuButton label="ファイル選択" disabled={isLoading}>
          <div
            onClick={openFilesDirect}
            style={{ padding: '10px 14px', fontSize: '14px', color: '#e0e0e0', cursor: 'pointer' }}
          >ファイルを開く...</div>
          <div
            onClick={() => openViaFolder()}
            style={{
              padding: '10px 14px', fontSize: '14px', color: '#e0e0e0', cursor: 'pointer',
              borderBottom: history.length > 0 ? '1px solid #2a2a2a' : 'none',
            }}
          >📁 フォルダを開く...</div>
          {history.map((entry, i) => (
            <div
              key={i}
              onClick={() => openViaFolder(entry.handle)}
              title={entry.label}
              style={{
                padding: '8px 14px', fontSize: '13px', color: '#aaa', cursor: 'pointer',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >📁 {entry.label}</div>
          ))}
        </OpenMenuButton>
      ) : (
        <label style={{
          backgroundColor: '#e0e0e0', color: '#111', borderRadius: '3px',
          padding: '4px 10px', fontSize: '14px', fontWeight: 700,
          cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.5 : 1,
        }}>
          ファイル選択
          <input
            type="file"
            accept=".csv,.vtd"
            multiple
            onChange={handleFallbackChange}
            disabled={isLoading}
            style={{ display: 'none' }}
          />
        </label>
      )}

      <span style={{ color: '#888', fontSize: '14px' }}>{loadedFileLabel}</span>
      {canSave && (
        <button
          onClick={saveChartFile}
          title={canOverwrite
            ? '水平線・垂直線・四角形をCSVと1つのファイルにまとめて上書き保存する（元のファイルへ直接書き込み）'
            : '水平線・垂直線・四角形をCSVと1つのファイルにまとめて保存（同じファイル選択欄からそのまま再読込できる）'}
          style={{
            backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
            borderRadius: '3px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
          }}
        >💾 vtd{canOverwrite ? '上書き保存' : '保存'}</button>
      )}

      {loadingMsg && (
        <span style={{
          color: isLoading ? '#666' : '#66bb6a',
          fontSize: '13px', fontVariantNumeric: 'tabular-nums',
        }}>
          {loadingMsg}
        </span>
      )}
    </div>
  );
}
