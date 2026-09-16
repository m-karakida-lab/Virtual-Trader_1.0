// フリーハンド（ブラシ）ストロークが三角形/円に近い場合、綺麗な図形へスナップする
// （iPad等のペン機能にある図形認識と同種の処理。AIは使わず古典的な幾何アルゴリズムのみ）。
// 判定順序: (1) 始点と終点が近い＝閉じたストロークかを見る。閉じていなければ対象外
// （直線や普通の手描きはそのままフリーハンド扱い）。(2) Douglas-Peucker法で頂点を単純化し、
// ほぼ同じ場所にある頂点をマージした上で頂点数がちょうど3なら三角形として頂点をそのまま
// 直線で結ぶ（正三角形に矯正はせず、描いた大きさ・向き・歪みはそのまま尊重する）。
// (3) 単純化してもなお頂点数が多い（＝直線的な多角形ではない）場合、バウンディングボックスに
// フィットした楕円からの相対距離のばらつきが小さければ円として楕円をフィットさせる
// （centroidからの単純な半径ではなく楕円基準にすることで、手描きにありがちな卵形・
// ドーム型の“歪んだ円”も正しく円として拾えるようにしている）。
// どちらにも該当しなければnullを返し、呼び出し側は通常のフリーハンド保存にフォールバックする

export type Pt = { x: number; y: number };

export type RecognizedShape =
  | { type: 'circle'; points: Pt[] }   // 楕円の外周をなぞる点列（既存のブラシ描画をそのまま使う）
  | { type: 'triangle'; points: Pt[] }; // 頂点3つ+始点に戻る計4点（直線描画・平滑化なしで使う）

const CLOSE_RATIO = 0.35; // 始点-終点の距離 / ストローク全長。これ未満なら「閉じている」とみなす
const CIRCLE_CV = 0.16; // 楕円基準の相対距離の変動係数（標準偏差/平均）。これ未満なら円とみなす
const SIMPLIFY_EPSILON_RATIO = 0.045; // Douglas-Peuckerのepsilon（バウンディングボックス対角線に対する比率）
const CORNER_MERGE_RATIO = 0.12; // 単純化後、隣り合う頂点がこの比率（対角線基準）より近ければ同一頂点とみなしマージする
const MIN_CIRCLE_CORNERS = 6; // 単純化後の頂点数がこれ未満（四角形等、直線的な多角形）なら円と誤認しない
const MIN_POINTS = 8; // これ未満の点数は判定材料が少なすぎるため対象外
const MIN_SIZE_PX = 16; // バウンディングボックスがこれより小さければ誤操作防止のため対象外
const CIRCLE_STEPS = 64; // 生成する楕円の分割数（straight:trueで直線つなぎ描画するため、滑らかに見える程度に細かくする）

function pathLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const projX = a.x + t * dx, projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Douglas-Peucker法によるポリライン単純化（角の少ない多角形へ間引く）
function simplify(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return pts;
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpendicularDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = simplify(pts.slice(0, maxIdx + 1), epsilon);
    const right = simplify(pts.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [pts[0], pts[pts.length - 1]];
}

// 手描きの角は1点にきれいに収束せず、単純化後も至近距離に複数の頂点として残ることがある
// （例: 三角形の頂点でペンが少しオーバーシュートして戻る動き）。輪の隣接ペアを順に見て、
// 近すぎる頂点は1つにマージする（平均位置に統合）
function mergeCloseCorners(corners: Pt[], threshold: number): Pt[] {
  if (corners.length < 4) return corners;
  const merged: Pt[] = [];
  let i = 0;
  while (i < corners.length) {
    let group = [corners[i]];
    let j = i + 1;
    while (j < corners.length && Math.hypot(corners[j].x - group[0].x, corners[j].y - group[0].y) < threshold) {
      group.push(corners[j]);
      j++;
    }
    merged.push({
      x: group.reduce((a, p) => a + p.x, 0) / group.length,
      y: group.reduce((a, p) => a + p.y, 0) / group.length,
    });
    i = j;
  }
  // 輪の先頭と末尾も隣接なのでマージ対象
  if (merged.length >= 4 && Math.hypot(merged[0].x - merged[merged.length - 1].x, merged[0].y - merged[merged.length - 1].y) < threshold) {
    const a = merged.shift()!;
    const b = merged.pop()!;
    merged.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return merged;
}

export function recognizeShape(rawPoints: Pt[]): RecognizedShape | null {
  if (rawPoints.length < MIN_POINTS) return null;

  const first = rawPoints[0], last = rawPoints[rawPoints.length - 1];
  const perimeter = pathLength(rawPoints);
  if (perimeter === 0) return null;
  const closeGap = Math.hypot(last.x - first.x, last.y - first.y);
  if (closeGap / perimeter > CLOSE_RATIO) return null; // 閉じていないストロークは対象外

  const xs = rawPoints.map(p => p.x), ys = rawPoints.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  if (w < MIN_SIZE_PX || h < MIN_SIZE_PX) return null;
  const diag = Math.hypot(w, h);

  // 閉じたループとして扱う（終点を始点にぴったり合わせる）
  const closed = [...rawPoints.slice(0, -1), first];

  // 先にDouglas-Peuckerで単純化し、頂点数を「直線的な多角形かどうか」の判定材料にする。
  // 四角形等は少ない頂点数にきれいに単純化できてしまうため、円判定はこの後に頂点数条件も
  // 課して区別する
  const epsilon = diag * SIMPLIFY_EPSILON_RATIO;
  const simplified = simplify(closed, epsilon);
  const rawCorners = simplified.slice(0, -1); // 末尾は始点に戻るだけの重複点なので除く
  const corners = mergeCloseCorners(rawCorners, diag * CORNER_MERGE_RATIO);

  // 三角形判定: 単純化・マージ後の頂点数がちょうど3か
  if (corners.length === 3) {
    return { type: 'triangle', points: [...corners, corners[0]] };
  }

  // 円判定: 単純化してもなお頂点数が多い（＝直線ではなく曲線）かつ、バウンディング楕円
  // からの相対距離のばらつきが小さいか。centroidからの単純な半径ではなく楕円基準にする
  // ことで、手描きの卵形・ドーム型の“歪んだ円”も円として拾えるようにする
  if (corners.length >= MIN_CIRCLE_CORNERS) {
    const rx = w / 2, ry = h / 2;
    const ecx = minX + rx, ecy = minY + ry;
    const relRadii = closed.map(p => Math.hypot((p.x - ecx) / rx, (p.y - ecy) / ry));
    const meanR = relRadii.reduce((a, b) => a + b, 0) / relRadii.length;
    const variance = relRadii.reduce((a, b) => a + (b - meanR) ** 2, 0) / relRadii.length;
    const cv = meanR > 0 ? Math.sqrt(variance) / meanR : Infinity;
    if (cv < CIRCLE_CV) {
      const points: Pt[] = [];
      for (let i = 0; i <= CIRCLE_STEPS; i++) {
        const a = (i / CIRCLE_STEPS) * Math.PI * 2;
        points.push({ x: ecx + rx * Math.cos(a), y: ecy + ry * Math.sin(a) });
      }
      return { type: 'circle', points };
    }
  }

  return null;
}
