import type { IChartApi } from 'lightweight-charts';
import type { Candle } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import { SESSIONS, type SessionBand } from '../../lib/sessions';
import type { ReadRef, TimeToX } from './refs';

// チャート下部に積む行（セッション帯・売買マーカー行）の配置寸法。売買マーカー行は
// セッション帯の上に積むため、CandleChart側からも参照する
export const SESSION_ROW_HEIGHT = 4; // px。下のスクラバー本体（bar、太さ4px）と揃える
export const SCRUBBER_TRACK_HEIGHT = 20; // px。下のscrubberTrackRefの高さと揃える（判定域込み）
export const SESSION_ROW_GAP = 6; // px。スクラバーとの間隔
export const SESSION_MARKER_GAP = 3; // px。セッション帯の上端から現在足の白い縦目印までの間隔
export const SESSION_MARKER_HEIGHT = 8; // px。現在足の白い縦目印の高さ

export interface SessionsOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  // セッション帯の区間（computeSessionBandsの結果）。CandleChart側のeffectが足の更新時に差し替える
  bandsRef: ReadRef<SessionBand[]>;
  elsRef: ReadRef<HTMLDivElement[]>;
  // 現在足の白い縦目印。初回呼び出し時にここで作ってrefへ保存する
  markerElRef: { current: HTMLDivElement | null };
  displayCandlesRef: ReadRef<Candle[]>;
  effectiveCursorRef: ReadRef<number>;
  timeframeSecRef: ReadRef<number>;
  timeToX: TimeToX;
}

// ── 東京/ロンドン/NYセッション帯の位置を再計算してDOMに反映 ──
// 全面を覆う薄い背景帯だと見づらいという指摘を受け、下の全期間スクラバー（YouTubeの
// シークバーと同じ見た目・高さ）の少し上に、それと同じ太さの1行で濃い色で描く方式に
// 変更した。日足以上は1本のローソク足が1日分になり表示する意味が無いため、その時間軸
// では隠す。週区切り線と同じくDOMオーバーレイ方式
export function createSyncSessions(deps: SessionsOverlayDeps): () => void {
  const { chartRef, overlayRef, bandsRef, elsRef, markerElRef, displayCandlesRef, effectiveCursorRef, timeframeSecRef, timeToX } = deps;
  return () => {
    if (!chartRef.current || !overlayRef.current) return;
    const { showSessions: show, chartBottomMargin: bottomMargin } = useTraderStore.getState();
    const visible = show && timeframeSecRef.current < 86400;
    const overlay = overlayRef.current;
    overlay.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const bands = bandsRef.current;
    const els = elsRef.current;

    while (els.length < bands.length) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.height = `${SESSION_ROW_HEIGHT}px`;
      el.style.borderRadius = '2px';
      el.style.pointerEvents = 'none';
      overlay.appendChild(el);
      els.push(el);
    }
    while (els.length > bands.length) {
      els.pop()?.remove();
    }

    // 現在足（メインはcursor、非メインは表示中の末尾＝effectiveCursorRef）がどのセッションに
    // 属するか（境目にいる時にどちらのセッションか分かりにくいという指摘対策）。
    // 各セッションは[start, end)の半開区間で重ならないよう定義済みなので、含む帯は必ず1つ
    const currentCandle = displayCandlesRef.current[effectiveCursorRef.current];
    const currentTime = currentCandle?.time;
    const activeIdx = currentTime === undefined
      ? -1
      : bands.findIndex(b => currentTime >= b.start && currentTime < b.end);

    bands.forEach((band, i) => {
      const el = els[i];
      const isActive = i === activeIdx;
      el.style.bottom = `${bottomMargin + SCRUBBER_TRACK_HEIGHT + SESSION_ROW_GAP}px`;
      // band.endがまだ先の未来（リプレイでcursorより先＝未開示）だと、その時刻のローソク足が
      // まだseriesにsetDataされておらずtimeToCoordinateが解決できずnullになる（timeToXの
      // 補間フォールバックも両隣の足が未開示だと同様に失敗する）。そのため「東京・ロンドンは
      // すぐ出るのにNY（終了が翌7時で一番長く未来にはみ出す）だけ、cursorが実際に翌7時
      // 付近まで進まないと帯が出ない」という不具合になっていた。帯の終端をcurrentTime
      // （このパネルで実際に開示済みの最後の足）にクランプし、開示済みの範囲までだけ
      // 描画することで回避する（開示が進むにつれ帯が右へ伸びていく形になる）。
      // クランプ先はcurrentTime（開示済み最後の足の"開始"時刻）ではなく、その足の"終わり"
      // （+timeframeSec）にすること。開始時刻のままだと、セッション開始のちょうどその足に
      // cursorが来た瞬間はband.start===currentTimeでクランプ後の帯幅が0になり、次の足まで
      // 進むまで帯が出ない（1H足で1時間分遅れて表示される）不具合になっていた
      if (currentTime !== undefined && band.start > currentTime) {
        el.style.display = 'none';
        return;
      }
      const revealedEnd = currentTime !== undefined ? currentTime + timeframeSecRef.current : undefined;
      const clampedEnd = revealedEnd !== undefined ? Math.min(band.end, revealedEnd) : band.end;
      const x0 = timeToX(band.start);
      const x1 = timeToX(clampedEnd);
      if (x0 === null || x1 === null || x1 <= x0) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.left = `${x0}px`;
      el.style.width = `${x1 - x0}px`;
      el.style.background = SESSIONS.find(s => s.key === band.key)!.color;
      // 白枠＋発光は撤回。今いるセッションの帯だけ不透明度を上げて色を濃く見せるだけの
      // 演出にする（他の帯は薄く、境目でもどちらが濃いかで一目で分かる）。
      // NY終了(7時)〜アジア開始(9時)のようにどのセッションにも属さない時間帯
      // （activeIdx===-1）は、どれも「今いる」わけではないので全部薄くする
      // （以前はここを「判定できない＝全部濃く」にしていたため、セッション外の時間で
      // 全帯が濃く見える不具合になっていた）
      el.style.opacity = isActive ? '1' : '0.45';
    });

    // 現在足の位置に白い縦の目印を立てる（進捗バーはやりすぎという指摘で撤回し、線1本に戻した）
    if (!markerElRef.current) {
      const marker = document.createElement('div');
      marker.style.position = 'absolute';
      marker.style.width = '2px';
      marker.style.pointerEvents = 'none';
      marker.style.backgroundColor = '#fff';
      marker.style.boxShadow = '0 0 3px rgba(255,255,255,0.9)';
      overlay.appendChild(marker);
      markerElRef.current = marker;
    }
    const marker = markerElRef.current;
    const mx = currentTime !== undefined ? timeToX(currentTime) : null;
    const rowBottom = bottomMargin + SCRUBBER_TRACK_HEIGHT + SESSION_ROW_GAP;
    if (mx === null) {
      marker.style.display = 'none';
    } else {
      marker.style.display = 'block';
      marker.style.left = `${mx - 1}px`;
      // アクティブな帯の白枠（outline）と同じ位置・同じ白だと埋もれて見えなくなるため、
      // 帯の上端よりさらに上に離して配置する（帯と重ねない）
      marker.style.bottom = `${rowBottom + SESSION_ROW_HEIGHT + SESSION_MARKER_GAP}px`;
      marker.style.height = `${SESSION_MARKER_HEIGHT}px`;
    }
  };
}
