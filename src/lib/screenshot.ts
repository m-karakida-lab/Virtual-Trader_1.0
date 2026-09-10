// チャート領域（App.tsxが`id="vt-chart-capture-area"`を振っている、CSV選択欄・描画ツール
// バー・下部の発注/操作パネルを含まない範囲）をPNGとして保存する。4画面時もこの1つの
// divに4枠すべてが収まっているため、そのままキャプチャすれば自然に1枚絵になる。
// html-to-imageは対象内の<canvas>（lightweight-chartsの描画本体）の現在のピクセル内容も
// 含めて書き出すため、ローソク足・雲・価格軸・日付軸もそのまま画像に残る
// PNG（可逆圧縮）だとpixelRatio:2で800KB近くなる。チャート画像は多少の非可逆ノイズが
// 乗ってもローソク足・線の判読にはほぼ影響しないため、JPEGにしてファイルサイズを縮める
import { toJpeg } from 'html-to-image';

const CAPTURE_AREA_ID = 'vt-chart-capture-area';
// キャプチャから除外するUI要素のid（再生/1コマ送り/戻しのフローティングパネル等）。
// 実際にDOMから隠して復元するのではなく、html-to-imageのfilterでレンダリング対象から
// 除外するだけなので、画面上には一切ちらつきが出ない
const EXCLUDED_IDS = ['vt-floating-controls'];

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function captureChartArea(filenameHint: string): Promise<void> {
  const el = document.getElementById(CAPTURE_AREA_ID);
  if (!el) return;
  const dataUrl = await toJpeg(el, {
    backgroundColor: '#0d0d0d',
    pixelRatio: 2,
    quality: 0.85,
    filter: node => !(node instanceof HTMLElement && EXCLUDED_IDS.includes(node.id)),
  });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${filenameHint}_${timestamp()}.jpg`;
  a.click();
}
