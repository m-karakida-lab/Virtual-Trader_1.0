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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// toBlobはエンコードをメインスレッドの外で行うので、品質探索中も画面が固まらない
function encode(src: HTMLCanvasElement, mime: string, q: number): Promise<Blob | null> {
  return new Promise(resolve => src.toBlob(resolve, mime, q));
}

// 上限以内で最も高い品質を二分探索で探す（段階を粗くすると上限を大きく下回って画質を無駄にする）。
// 最低品質でも収まらなければnull
async function fitQuality(src: HTMLCanvasElement): Promise<string | null> {
  const probe = await encode(src, 'image/webp', 0.5);
  const mime = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const top = await encode(src, mime, RR_Q_MAX);
  if (top && top.size <= RR_IMAGE_MAX_BYTES) return blobToDataUrl(top);
  let best: Blob | null = null;
  let lo = RR_Q_MIN, hi = RR_Q_MAX;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const b = await encode(src, mime, mid);
    if (b && b.size <= RR_IMAGE_MAX_BYTES) { best = b; lo = mid; } else hi = mid;
  }
  return best ? blobToDataUrl(best) : null;
}

// 画面の見た目を今この瞬間のピクセルとして取り込む（発注直後に下書きが消えても、
// 取り込み済みのcanvasは変わらない）。エンコードより前に済ませる必要がある部分
export async function captureChartAreaCanvas(excludedIds: string[] = RR_EXCLUDED_IDS): Promise<HTMLCanvasElement | null> {
  const el = document.getElementById(CAPTURE_AREA_ID);
  if (!el) return null;
  try {
    // html-to-imageに<canvas>を任せると、1パネルに十数枚重なるcanvasを1枚ずつPNG化→画像として
    // 再デコードするため1秒以上かかる（HiDPIでさらに悪化）。canvasは直接drawImageで重ね、
    // html-to-imageには<canvas>を除いたDOM（ラベル・ヘッダー・R:R箱など）だけを描かせ、その上に重ねる
    const areaRect = el.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.round(areaRect.width);
    out.height = Math.round(areaRect.height);
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    // 領域いっぱいに敷かれた背景（複数画面の区切りの色）は、canvasより下に自前で塗り、DOM側では
    // 一時的に透明にして描く（DOM層をcanvasの上に重ねるため、残すとチャート全体を覆ってしまう）。
    // 区切りの細い線の色が1フレーム抜けるだけで、復元は撮影直後
    let baseColor = '#0d0d0d';
    const restore: (() => void)[] = [];
    for (const n of el.querySelectorAll<HTMLElement>('*')) {
      if (n instanceof HTMLCanvasElement) continue;
      const bg = getComputedStyle(n).backgroundColor;
      if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
      const r = n.getBoundingClientRect();
      if (r.width * r.height < areaRect.width * areaRect.height * 0.8) continue;
      baseColor = bg;
      const prev = n.style.backgroundColor;
      n.style.backgroundColor = 'transparent';
      restore.push(() => { n.style.backgroundColor = prev; });
    }
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, out.width, out.height);
    // HiDPIのcanvasを等倍へ縮小して重ねるので、既定（low）の補間だと細い線が荒れる
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // canvasはz-index（無指定は0）の昇順、同じなら文書順で重ねる
    const canvases = [...el.querySelectorAll('canvas')]
      .filter(c => !excludedIds.some(id => document.getElementById(id)?.contains(c)))
      .map((c, i) => ({ c, i, z: Number.parseInt(getComputedStyle(c).zIndex, 10) || 0 }))
      .sort((a, b) => a.z - b.z || a.i - b.i);
    // 空（全面透明）のオーバーレイcanvasが大半なので、高品質の縮小描画（重い）の前に、表示サイズへ
    // 粗く縮小して中身が空かを調べて飛ばす
    const probe = document.createElement('canvas');
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    const isBlank = (c: HTMLCanvasElement, w: number, h: number): boolean => {
      if (!probeCtx) return false;
      probe.width = Math.max(1, Math.round(w));
      probe.height = Math.max(1, Math.round(h));
      probeCtx.imageSmoothingQuality = 'low';
      probeCtx.drawImage(c, 0, 0, probe.width, probe.height);
      const px = new Uint32Array(probeCtx.getImageData(0, 0, probe.width, probe.height).data.buffer);
      for (let i = 0; i < px.length; i++) if (px[i] !== 0) return false;
      return true;
    };
    for (const { c } of canvases) {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (c.width > r.width && isBlank(c, r.width, r.height)) continue;
      ctx.globalAlpha = Number(cs.opacity) || 1;
      ctx.drawImage(c, r.left - areaRect.left, r.top - areaRect.top, r.width, r.height);
    }
    ctx.globalAlpha = 1;

    let dom: HTMLCanvasElement;
    try {
      dom = await toCanvas(el, {
        pixelRatio: 1,
        // 使っているのはシステムフォントだけなので、全スタイルシートを走査してフォントを埋め込む処理は不要
        skipFonts: true,
        filter: node => !(node instanceof HTMLCanvasElement) && !(node instanceof HTMLElement && excludedIds.includes(node.id)),
      });
    } finally {
      restore.forEach(f => f());
    }
    ctx.drawImage(dom, 0, 0);
    return out;
  } catch {
    return null;
  }
}

// canvasを上限以内の高画質画像（data URL）にする。重いので発注の完了を待たせず裏で呼ぶ
export async function encodeCanvasFitted(canvas: HTMLCanvasElement): Promise<string | null> {
  try {
    let src = canvas;
    let scale = 1;
    for (;;) {
      const best = await fitQuality(src);
      if (best) return best;
      scale *= 0.85;
      if (scale < 0.4) {
        const b = await encode(src, 'image/webp', RR_Q_MIN);
        return b ? blobToDataUrl(b) : null;
      }
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

export async function captureChartAreaDataUrl(excludedIds: string[] = RR_EXCLUDED_IDS): Promise<string | null> {
  const canvas = await captureChartAreaCanvas(excludedIds);
  return canvas ? encodeCanvasFitted(canvas) : null;
}
