import { useEffect, useRef, useState } from 'react';
import { FileLoader } from './components/FileLoader';
import { CandleChart } from './components/CandleChart';
import { Controls } from './components/Controls';
import { HistoryPanel } from './components/HistoryPanel';
import { FloatingControls } from './components/FloatingControls';
import { DrawToolbar } from './components/DrawToolbar';
import { PalettePanel } from './components/PalettePanel';
import { OrderPanel } from './components/OrderPanel';
import { useTraderStore } from './store/useTraderStore';
import { initDuckDB } from './lib/duckdb';

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
          {/* 1画面/4画面とも常にこの4枠構成のまま保つ（chartLayoutでJSXの分岐自体を
              切り替えない）。1画面時はメイン枠だけを画面いっぱいに表示し、残り3枠は
              width/height:0で隠すだけでマウントは維持する。以前はchartLayout==='1'の時
              別途<CandleChart/>を単独レンダーしており、切替のたびに4枠側がまるごと
              unmount→再mountしていた（レイアウト切替で表示位置・ズームが毎回リセット
              されてしまうという指摘を受けて発覚）。全枠を常時マウントし続けることで
              lightweight-chartsのチャートインスタンス自体を破棄しないようにし、
              1画面⇔4画面を行き来しても各枠の表示状態がそのまま保たれるようにした */}
          <div style={{
            position: 'absolute', inset: 0,
            display: chartLayout === '4' ? 'grid' : 'block',
            gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '2px',
          }}>
            {QUAD_POSITIONS.map((pos, slot) => {
              const isMainSlot = slot === quadMainSlot;
              const cellStyle = chartLayout === '4'
                ? { gridRow: pos.row, gridColumn: pos.col, position: 'relative' as const, minWidth: 0, minHeight: 0 }
                : isMainSlot
                  ? { position: 'absolute' as const, inset: 0 }
                  : { position: 'absolute' as const, width: 0, height: 0, overflow: 'hidden' as const, pointerEvents: 'none' as const };
              return (
                <div key={slot} style={cellStyle}>
                  <CandleChart
                    slot={slot}
                    isMain={isMainSlot}
                    timeframeSec={quadTimeframes[slot]}
                  />
                  {/* 4画面時、全枠を細い枠線で区切りつつ、メイン枠（操作対象）だけ青で
                      一目で分かるようにする。1画面時はメイン枠しか表示されないため不要
                      （つけると常時囲われて煩わしいだけ）。セルのboxShadowで描くと
                      CandleChart側のチャート本体（不透明な背景を持つ）に上から塗りつぶされ、
                      枠の一部（チャートの描画範囲が届かない隙間）しか見えなくなってしまう
                      （実際に下端の一部しか出ない不具合として発覚）。CandleChartの後に
                      重ねて描く別要素にすることで、チャート本体より上のレイヤーに出るように
                      している（pointerEvents:noneでクリック等は透過させる） */}
                  {chartLayout === '4' && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      boxShadow: isMainSlot
                        ? 'inset 0 0 0 0.5px rgba(66, 165, 245, 0.8)'
                        : 'inset 0 0 0 0.5px rgba(192, 192, 192, 0.25)',
                      pointerEvents: 'none', zIndex: 10,
                    }} />
                  )}
                </div>
              );
            })}
          </div>
          <FloatingControls />
          <PalettePanel />
          <OrderPanel />
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
