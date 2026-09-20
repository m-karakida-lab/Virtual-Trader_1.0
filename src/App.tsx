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
// ユーザーが選べる（store.quad4Timeframes、インデックスがこの配列の並びに対応）
const QUAD_POSITIONS: { row: string; col: string }[] = [
  { row: '1', col: '1' }, // 左上
  { row: '2', col: '1' }, // 左下
  { row: '1', col: '2' }, // 右上
  { row: '2', col: '2' }, // 右下
];

// 3画面レイアウトの枠位置。枠0は常に「大きい方の枠」、枠1/2は残り2枠（store.quad3Timeframesの
// 0,1,2番に対応、4画面用のquad4Timeframesとは完全に別管理）。パターンはstore.quad3Patternで選ぶ
const THREE_POSITIONS_LEFT: { row: string; col: string }[] = [
  { row: '1 / 3', col: '1' }, // 左（縦通し）
  { row: '1', col: '2' },     // 右上
  { row: '2', col: '2' },     // 右下
];
const THREE_POSITIONS_TOP: { row: string; col: string }[] = [
  { row: '1', col: '1 / 3' }, // 上（横通し）
  { row: '2', col: '1' },     // 下左
  { row: '2', col: '2' },     // 下右
];

export default function App() {
  const error      = useTraderStore(s => s.error);
  const clearError = useTraderStore(s => s.clearError);
  const isLoaded   = useTraderStore(s => s.isLoaded);
  const showHistoryPanel = useTraderStore(s => s.showHistoryPanel);
  const chartLayout   = useTraderStore(s => s.chartLayout);
  const preMultiLayout = useTraderStore(s => s.preMultiLayout);
  const quad4Timeframes = useTraderStore(s => s.quad4Timeframes);
  const quad4MainSlot  = useTraderStore(s => s.quad4MainSlot);
  const quad3Timeframes = useTraderStore(s => s.quad3Timeframes);
  const quad3MainSlot  = useTraderStore(s => s.quad3MainSlot);
  const quad3Pattern  = useTraderStore(s => s.quad3Pattern);
  const loadFiles  = useTraderStore(s => s.loadFiles);

  // 1画面表示中は直前のマルチ画面レイアウト（preMultiLayout）が実質的にアクティブな方。
  // 3画面と4画面は完全に別管理のため、どちらの枠設定を見るかはここで一度だけ決める
  const activeQuadLayout = chartLayout === '1' ? preMultiLayout : chartLayout;

  // 画面表示時点で DuckDB WASM を先読み（ファイル選択前に初期化を済ませる）
  useEffect(() => { initDuckDB().catch(() => {}); }, []);

  // vtdの自動保存タイマー（10分ごと）。手動で「上書き保存」を1回成功させるまでは
  // store側のautoSaveArmedがfalseのため実質no-op、前回保存から変化が無い時もスキップされる
  useEffect(() => {
    const id = setInterval(() => {
      void useTraderStore.getState().autoSaveTick();
    }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // スペースキーで「1コマ進む」（FloatingControlsの⏭ボタンと同じadvance()）。
  // ここ（App.tsx側1箇所）で拾うのは、CandleChartは4画面時に4インスタンス同時に
  // マウントされておりインスタンスごとにwindow.addEventListenerすると同じキー入力に
  // 4回反応してしまうため（Delete/Undo/コピペ等はパネル固有の操作なのでactivePanelSlotで
  // 絞っているが、advance()はパネルに依存しないグローバルな操作なのでそもそも1箇所で
  // 受ければ足りる）。テキストボックス編集中はスペース入力を奪わないよう除外する
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const active = document.activeElement as HTMLElement | null;
      const tag = (active?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || active?.isContentEditable) return;
      e.preventDefault(); // ページスクロール・フォーカス中ボタンの再クリックを防ぐ
      useTraderStore.getState().advance();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
          {/* 1画面/3画面/4画面とも常にこの4枠構成のまま保つ（chartLayoutでJSXの分岐自体を
              切り替えない）。1画面時はメイン枠だけを画面いっぱいに表示し、3画面時は枠3を、
              1画面時は非メイン3枠を、それぞれwidth/height:0で隠すだけでマウントは維持する。
              以前はchartLayout==='1'の時別途<CandleChart/>を単独レンダーしており、切替の
              たびに4枠側がまるごとunmount→再mountしていた（レイアウト切替で表示位置・ズーム
              が毎回リセットされてしまうという指摘を受けて発覚）。全枠を常時マウントし続ける
              ことでlightweight-chartsのチャートインスタンス自体を破棄しないようにし、
              画面数を行き来しても各枠の表示状態がそのまま保たれるようにした */}
          <div style={{
            position: 'absolute', inset: 0,
            display: chartLayout === '1' ? 'block' : 'grid',
            gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '2px',
          }}>
            {QUAD_POSITIONS.map((_, slot) => {
              // 3画面と4画面は各枠の時間軸・メイン枠を別管理しているため、どちらの状態を
              // 見るかはactiveQuadLayout（1画面中は直前のマルチ画面レイアウト）で判定する
              const isMainSlot = activeQuadLayout === '3' ? slot === quad3MainSlot : slot === quad4MainSlot;
              // 3画面時の枠3にはquad3Timeframesの対応が無い（このレイアウトでは使わないため）。
              // 常に非表示になる枠なので値そのものは何でもよく、quad4側の値を流用するだけ
              const timeframeSec = activeQuadLayout === '3'
                ? (slot < 3 ? quad3Timeframes[slot] : quad4Timeframes[slot])
                : quad4Timeframes[slot];
              const threePositions = quad3Pattern === 'top' ? THREE_POSITIONS_TOP : THREE_POSITIONS_LEFT;
              const pos = chartLayout === '3' ? threePositions[slot] : QUAD_POSITIONS[slot];
              // 3画面時の枠3（このレイアウトでは使わない）は1画面時の非メイン枠と同じ扱いで隠す
              const isHiddenInThreeUp = chartLayout === '3' && slot === 3;
              const cellStyle = (chartLayout === '4' || (chartLayout === '3' && !isHiddenInThreeUp))
                ? { gridRow: pos.row, gridColumn: pos.col, position: 'relative' as const, minWidth: 0, minHeight: 0 }
                : isMainSlot && chartLayout === '1'
                  ? { position: 'absolute' as const, inset: 0 }
                  : { position: 'absolute' as const, width: 0, height: 0, overflow: 'hidden' as const, pointerEvents: 'none' as const };
              return (
                <div key={slot} style={cellStyle}>
                  <CandleChart
                    slot={slot}
                    isMain={isMainSlot}
                    timeframeSec={timeframeSec}
                  />
                  {/* マルチ画面時、全枠を細い枠線で区切りつつ、メイン枠（操作対象）だけ青で
                      一目で分かるようにする。1画面時はメイン枠しか表示されないため不要
                      （つけると常時囲われて煩わしいだけ）。セルのboxShadowで描くと
                      CandleChart側のチャート本体（不透明な背景を持つ）に上から塗りつぶされ、
                      枠の一部（チャートの描画範囲が届かない隙間）しか見えなくなってしまう
                      （実際に下端の一部しか出ない不具合として発覚）。CandleChartの後に
                      重ねて描く別要素にすることで、チャート本体より上のレイヤーに出るように
                      している（pointerEvents:noneでクリック等は透過させる） */}
                  {(chartLayout === '4' || (chartLayout === '3' && !isHiddenInThreeUp)) && (
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
