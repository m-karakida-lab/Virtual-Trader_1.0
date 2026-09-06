// チャート領域（App.tsxが`id="vt-chart-capture-area"`を振っている、CSV選択欄・描画ツール
// バー・下部の発注/操作パネルを含まない範囲）をPNGとして保存する。4画面時もこの1つの
// divに4枠すべてが収まっているため、そのままキャプチャすれば自然に1枚絵になる。
// html-to-imageは対象内の<canvas>（lightweight-chartsの描画本体）の現在のピクセル内容も
// 含めて書き出すため、ローソク足・雲・価格軸・日付軸もそのまま画像に残る
import { toPng } from 'html-to-image';

const CAPTURE_AREA_ID = 'vt-chart-capture-area';

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function captureChartArea(filenameHint: string): Promise<void> {
  const el = document.getElementById(CAPTURE_AREA_ID);
  if (!el) return;
  const dataUrl = await toPng(el, { backgroundColor: '#0d0d0d', pixelRatio: 2 });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${filenameHint}_${timestamp()}.png`;
  a.click();
}
