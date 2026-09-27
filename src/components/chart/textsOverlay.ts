import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import { CHART_FONT_FAMILY, DASH_TO_CSS } from '../../lib/chartTheme';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';

export interface TextsOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  // テキストごとのDOM要素（その要素自体が直接編集時のcontentEditableになる）
  elsRef: ReadRef<Map<number, HTMLDivElement>>;
  timeToX: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  // 直接編集中のテキストID（編集処理はCandleChart側が持つ）
  getEditingTextId: Getter<number | null>;
}

// テキストボックスの位置を再計算してDOMに反映する。四角形と同じく実体はDOM要素
// （pointer-events:none）で、当たり判定はCandleChart側で手動で行う。サイズは内容依存で
// time/priceからは決まらないため、幅・高さはDOMの自然なサイズに任せる
export function createSyncTexts(deps: TextsOverlayDeps): () => void {
  const { chartRef, seriesRef, overlayRef, elsRef, timeToX, getVisibleDrawings, getEditingTextId } = deps;
  return () => {
    if (!chartRef.current || !seriesRef.current || !overlayRef.current) return;
    const { texts: currentTexts, selected } = useTraderStore.getState();
    // hiddenTimeframesで非表示のテキストは、他の図形と違いDOM要素を削除せずdisplay:noneで
    // 隠すだけにする。要素がそのままcontentEditableの編集対象になるため、入力中に
    // 時間足ボタンを押して要素ごと消すと編集中の要素が宙に浮いてしまう。同じ理由で、
    // 編集中のテキストは非表示設定でも入力が終わるまでは表示し続ける
    const visibleTextIds = new Set(getVisibleDrawings().texts.map(t => t.id));
    const overlay = overlayRef.current;
    const existing = elsRef.current;
    const nextIds = new Set(currentTexts.map(t => t.id));
    const selectedTextId = selected?.kind === 'text' ? selected.id : null;
    const editingTextId = getEditingTextId();

    for (const [id, el] of existing) {
      if (!nextIds.has(id)) { el.remove(); existing.delete(id); }
    }

    for (const t of currentTexts) {
      // 編集中の実体はcontentEditableの入力中の文字を上書きしてはいけないが、色・文字
      // サイズ・枠線・位置はパレット側の変更をその場で反映したいため、textContentの
      // 上書きだけをスキップし、スタイル反映は編集中でも続ける
      const isEditing = editingTextId === t.id;
      let el = existing.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.pointerEvents = 'none';
        el.style.whiteSpace = 'pre';
        el.style.fontFamily = CHART_FONT_FAMILY;
        el.style.padding = '2px 4px';
        el.style.borderRadius = '2px';
        el.className = 'vt-text-editable';
        el.setAttribute('data-placeholder', '文字を入力');
        overlay.appendChild(el);
        existing.set(t.id, el);
      }
      if (!visibleTextIds.has(t.id) && !isEditing) { el.style.display = 'none'; continue; }
      const x = timeToX(t.time);
      const y = seriesRef.current.priceToCoordinate(t.price);
      if (x === null || y === null) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.fontSize = `${t.fontSize}px`;
      el.style.color = t.color;
      if (!isEditing) el.textContent = t.text;
      // 選択中は枠線自体を変えず（テキストの実際の枠設定を上書きしない）、box-shadowで
      // 選択リングを重ねるだけにする（四角形と違いハンドルを持たないため唯一の選択表示）
      const isSelected = t.id === selectedTextId;
      el.style.border = t.border === 'none' ? '1px solid transparent' : `1px ${DASH_TO_CSS[t.border]} ${t.color}`;
      el.style.backgroundColor = isSelected ? 'rgba(66,165,245,0.12)' : 'transparent';
      el.style.boxShadow = isSelected ? '0 0 0 1px #42a5f5' : 'none';
    }
  };
}
