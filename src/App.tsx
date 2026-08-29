import { useEffect } from 'react';
import { FileLoader } from './components/FileLoader';
import { CandleChart } from './components/CandleChart';
import { MiniChart } from './components/MiniChart';
import { Controls } from './components/Controls';
import { HistoryPanel } from './components/HistoryPanel';
import { FloatingControls } from './components/FloatingControls';
import { DrawToolbar } from './components/DrawToolbar';
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

  // 画面表示時点で DuckDB WASM を先読み（ファイル選択前に初期化を済ませる）
  useEffect(() => { initDuckDB().catch(() => {}); }, []);

  // エラーは数秒で自動的に消す
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 4000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: '#0d0d0d',
      color: '#e0e0e0',
      fontFamily: '"SF Mono", "Fira Code", monospace',
    }}>
      <FileLoader />

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
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
        <DrawToolbar />
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

      <Controls />
    </div>
  );
}
