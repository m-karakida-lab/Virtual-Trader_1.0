// チャート領域（App.tsxが`id="vt-chart-capture-area"`を振っている、CSV選択欄・描画ツール
// バー・下部の発注/操作パネルを含まない範囲）を画像にする。4画面時もこの1つのdivに4枠
// すべてが収まっているため、そのままキャプチャすれば自然に1枚絵になる。
// html-to-imageは対象内の<canvas>（lightweight-chartsの描画本体）の現在のピクセル内容も
// 含めて書き出すため、ローソク足・雲・価格軸・日付軸もそのまま画像に残る
import { toCanvas } from 'html-to-image';

const CAPTURE_AREA_ID = 'vt-chart-capture-area';
// キャプチャから除外するUI要素のid（再生/1コマ送り/戻しのフローティングパネル等）。
// 実際にDOMから隠して復元するのではなく、html-to-imageのfilterでレンダリング対象から
// 除外するだけなので、画面上には一切ちらつきが出ない
const EXCLUDED_IDS = ['vt-floating-controls'];
// 発注時のR:R記録用に追加で除外するもの（発注パネル自体は画像に写さない）
const RR_EXCLUDED_IDS = [...EXCLUDED_IDS, 'vt-order-panel'];

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function captureChartArea(filenameHint: string): Promise<void> {
  const dataUrl = await captureChartAreaDataUrl(EXCLUDED_IDS);
  if (!dataUrl) return;
  const ext = dataUrl.startsWith('data:image/webp') ? 'webp' : 'jpg';
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${filenameHint}_${timestamp()}.${ext}`;
  a.click();
}

// チャート領域のキャプチャ（「キャプチャ」ボタンの保存と、発注時のR:R記録で共用）。vtdにも埋め込むので容量を抑えつつ、
// 細い線（ヒゲ・グリッド）が潰れない鮮明さを優先する。WebP（無ければJPEG）で、上限
// RR_IMAGE_MAX_BYTESに収まる最も高い品質を探す。品質を下げきっても収まらなければ縮小する。
// 失敗しても発注自体は止めないのでnullを返す
const RR_IMAGE_MAX_BYTES = 100 * 1024;
const RR_Q_MAX = 0.95;
const RR_Q_MIN = 0.45;

function dataUrlBytes(url: string): number {
  return Math.floor((url.length - url.indexOf(',') - 1) * 0.75);
}

// 上限以内で最も高い品質を二分探索で探す（段階を粗くすると上限を大きく下回って画質を無駄にする）。
// 最低品質でも収まらなければnull
function fitQuality(src: HTMLCanvasElement): string | null {
  const mime = src.toDataURL('image/webp', 0.5).startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
  let best: string | null = null;
  let lo = RR_Q_MIN, hi = RR_Q_MAX;
  const top = src.toDataURL(mime, hi);
  if (dataUrlBytes(top) <= RR_IMAGE_MAX_BYTES) return top;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const url = src.toDataURL(mime, mid);
    if (dataUrlBytes(url) <= RR_IMAGE_MAX_BYTES) { best = url; lo = mid; } else hi = mid;
  }
  return best;
}

export async function captureChartAreaDataUrl(excludedIds: string[] = RR_EXCLUDED_IDS): Promise<string | null> {
  const el = document.getElementById(CAPTURE_AREA_ID);
  if (!el) return null;
  try {
    const canvas = await toCanvas(el, {
      backgroundColor: '#0d0d0d',
      pixelRatio: 1,
      filter: node => !(node instanceof HTMLElement && excludedIds.includes(node.id)),
    });
    let src: HTMLCanvasElement = canvas;
    let scale = 1;
    for (;;) {
      const best = fitQuality(src);
      if (best) return best;
      scale *= 0.85;
      if (scale < 0.4) return src.toDataURL('image/webp', RR_Q_MIN);
      const next = document.createElement('canvas');
      next.width = Math.round(canvas.width * scale);
      next.height = Math.round(canvas.height * scale);
      next.getContext('2d')?.drawImage(canvas, 0, 0, next.width, next.height);
      src = next;
    }
  } catch {
    return null;
  }
}
