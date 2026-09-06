import { useEffect, useRef, useState } from 'react';
import { FileLoader } from './components/FileLoader';
import { CandleChart } from './components/CandleChart';
import { MiniChart } from './components/MiniChart';
import { Controls } from './components/Controls';
import { HistoryPanel } from './components/HistoryPanel';
import { FloatingControls } from './components/FloatingControls';
import { DrawToolbar } from './components/DrawToolbar';
import { PalettePanel } from './components/PalettePanel';
import { useTraderStore } from './store/useTraderStore';
import { initDuckDB } from './lib/duckdb';
import { TIMEFRAMES } from './types';

// 4画面レイアウトの枠位置は固定（左上・左下・右上・右下）。各枠に表示する時間軸は
// ユーザーが選べる（store.quadTimeframes、インデックスがこの配列の並びに対応）
const QUAD_POSITIONS: { row: number; col: number }[] = [
  { row: 1, col: 1 }, // 左上
  { row: 2, col: 1 }, // 左下
  { row: 1, col: 2 }, // 右上
  { row: 2, col: 2 }, // 右下
];

export default function App() {
  const error      = useTraderStore(s => s.error);
  const clearError = useTraderStore(s => s.clearError);
  const isLoaded   = useTraderStore(s => s.isLoaded);
  const showHistoryPanel = useTraderStore(s => s.showHistoryPanel);
  const chartLayout   = useTraderStore(s => s.chartLayout);
  const quadTimeframes = useTraderStore(s => s.quadTimeframes);
  const quadMainSlot  = useTraderStore(s => s.quadMainSlot);
  const loadFiles  = useTraderStore(s => s.loadFiles);

  // 画面表示時点で DuckDB WASM を先読み（ファイル選択前に初期化を済ませる）
  useEffect(() => { initDuckDB().catch(() => {}); }, []);

  // 画面全体へのCSV/vtdファイルのドラッグ&ドロップ読み込み。子要素をまたぐたびに
  // dragenter/dragleaveが発火するため、カウンタで「本当に画面外に出たか」を判定する
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounter.current += 1;
    setIsDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault(); // これが無いとブラウザ標準の「ドロップでファイルを開く」に奪われる
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) loadFiles(e.dataTransfer.files);
  };

  // エラーは数秒で自動的に消す
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: '#0d0d0d',
        color: '#e0e0e0',
        fontFamily: '"SF Mono", "Fira Code", monospace',
        position: 'relative',
      }}
    >
      {isDragOver && (
        <div style={{
          position: 'absolute', inset: '8px', zIndex: 100,
          border: '2px dashed #42a5f5', borderRadius: '8px',
          backgroundColor: 'rgba(13,71,161,0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '18px', fontWeight: 700, color: '#42a5f5',
          pointerEvents: 'none',
        }}>
          ここにドロップして読み込む
        </div>
      )}
      <FileLoader />

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', display: 'flex' }}>
        {/* 描画ツールバー用の独立した列。チャート画面に重ねず、価格軸と同じく専用スペースを確保する。
            アイコンぴったりの幅（padding最小限）にして、ボタンサイズの割に間延びしないようにする */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center',
          padding: '4px', backgroundColor: '#111', borderRight: '1px solid #2a2a2a',
        }}>
          <DrawToolbar />
        </div>

        {/* 画面キャプチャ機能（Controls.tsx）の対象領域。チャート本体（ローソク足・右の価格軸・
            下の日付軸はlightweight-charts自体のcanvasに含まれる）だけを切り取り、上のCSV選択欄・
            左の描画ツールバー・下の発注/操作パネルは含めない。4画面時はこのdiv自体に4枠すべてが
            収まっているため、1回のキャプチャで自然に1枚絵になる */}
        <div id="vt-chart-capture-area" style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
          {chartLayout === '4' ? (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '2px',
            }}>
              {QUAD_POSITIONS.map((pos, slot) => (
                <div key={slot} style={{ gridRow: pos.row, gridColumn: pos.col, position: 'relative', minWidth: 0, minHeight: 0 }}>
                  {slot === quadMainSlot
                    ? <CandleChart />
                    : <MiniChart
                        timeframeSec={quadTimeframes[slot]}
                        label={TIMEFRAMES.find(tf => tf.sec === quadTimeframes[slot])!.label}
                        slot={slot}
                      />}
                </div>
              ))}
            </div>
          ) : (
            <CandleChart />
          )}
          <FloatingControls />
          <PalettePanel />
          {error && (
            <div style={{
              position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)',
              backgroundColor: '#3a0d0d', color: '#ff7b72', border: '1px solid #ef5350',
              borderRadius: '6px', padding: '12px 20px', fontSize: '15px', fontWeight: 700,
              boxShadow: '0 4px 16px rgba(0,0,0,0.6)', whiteSpace: 'nowrap', zIndex: 50,
              pointerEvents: 'none',
            }}>
              {error}
            </div>
          )}
          {!isLoaded && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#2a2a2a', fontSize: '15px', pointerEvents: 'none',
            }}>
              CSV を選択してください
            </div>
          )}
          {showHistoryPanel && <HistoryPanel />}
        </div>
      </div>

      <Controls />
    </div>
  );
}
