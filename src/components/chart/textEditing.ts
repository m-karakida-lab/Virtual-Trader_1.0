import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';

export interface TextEditingDeps {
  // テキストごとのDOM要素（その要素自体をcontentEditableにして直接編集する）
  textElsRef: ReadRef<Map<number, HTMLDivElement>>;
  // Escapeで既存テキストの編集を破棄した時に元の内容で描き直す。syncTextsは編集中IDを
  // この編集器から読むため、循環しないようref経由で受け取る
  syncTextsRef: ReadRef<() => void>;
}

// テキストの直接編集。TradingView同様window.prompt()を使わず、DOM要素自体をcontentEditableにして
// その場で直接入力させる。新規配置も既存編集も同じ経路: 新規配置は空文字のDrawnTextをまず作って
// しまい（addTextが選択状態にするので、パレットモードも自動でONになり「編集モード」に入る）、
// その実体をそのままcontentEditableにする。確定（blur）時に空文字のままなら削除、既存テキスト
// 編集中のEscapeは元の内容のまま（storeはまだ書き換えていない）表示に戻すだけ
export function createTextEditor(deps: TextEditingDeps) {
  const { textElsRef, syncTextsRef } = deps;
  let editingTextId: number | null = null;
  let editingTextEl: HTMLDivElement | null = null;

  // Enterキーは改行に使うため、ブラウザ標準の挙動（<div>/<br>を挿入する）に任せない。
  // <br>は確定時の`el.textContent`に一切寄与せず改行が消えるため、Selection/RangeでDOM文字ノード
  // として直接'\n'を挿入する（white-space:preで描画しているため、素の'\n'がそのまま改行として表示される。
  // execCommand('insertText')での改行挿入はブラウザ実装依存で<br>になることがあり使わない）
  const insertNewlineAtSelection = () => {
    const el = editingTextEl;
    if (!el) return;
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const nl = document.createTextNode('\n');
    range.insertNode(nl);
    range.setStartAfter(nl);
    range.setEndAfter(nl);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  // IME変換確定のEnterはkey==='Enter'として届くが、これは改行ではなく「変換を確定させたい」だけの
  // 入力なので常に素通しして確定処理をブラウザ/IMEに任せる（改行が欲しければもう一度Enterを押す）。
  // isComposingNowはcompositionstart/endで自前追跡する状態（keydown側のe.isComposingだけだと
  // ブラウザによって検知が不安定なことがあるため併用する）
  let isComposingNow = false;
  const onTextEditCompositionStart = () => { isComposingNow = true; };
  const onTextEditCompositionEnd = () => { isComposingNow = false; };

  // 編集中に矢印キー・Backspace・Cmd+Z等がグローバルショートカット（図形削除・Undo・コピペ）に
  // 奪われないよう伝播を止める（グローバル側もcontentEditableをガードしているが念のため）。
  // 確定はEnterではなくblur（他をクリック/Tab移動）、Escapeは破棄
  const onTextEditKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.isComposing || isComposingNow || e.keyCode === 229)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      insertNewlineAtSelection();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTextEdit();
    }
  };

  // 全部消してちょうど空になった時、ブラウザによっては`<br>`等の空ノードが1つ残ってDOM上は
  // 完全な空（:empty）にならず、プレースホルダーのCSS `:empty::before`が働かなくなる。
  // inputのたびにtextContentが空文字ならinnerHTMLごと空にしておく
  const onTextEditInput = (e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    if (el.textContent === '') el.innerHTML = '';
  };

  // 編集状態を解除してDOM要素を元の表示専用に戻し、編集していたIDを返す
  const stopEditing = (): { id: number; el: HTMLDivElement } | null => {
    const id = editingTextId;
    const el = editingTextEl;
    if (id === null || !el) return null;
    editingTextId = null;
    editingTextEl = null;
    el.removeEventListener('keydown', onTextEditKeyDown);
    el.removeEventListener('input', onTextEditInput);
    el.removeEventListener('compositionstart', onTextEditCompositionStart);
    el.removeEventListener('compositionend', onTextEditCompositionEnd);
    el.removeEventListener('blur', finishTextEdit);
    el.contentEditable = 'false';
    el.style.pointerEvents = 'none';
    return { id, el };
  };

  function finishTextEdit() {
    const stopped = stopEditing();
    if (!stopped) return;
    const content = (stopped.el.textContent || '').trim();
    if (content === '') useTraderStore.getState().removeText(stopped.id);
    else useTraderStore.getState().updateText(stopped.id, { text: content });
  }

  function cancelTextEdit() {
    const stopped = stopEditing();
    if (!stopped) return;
    // 新規配置直後（まだ何も確定しておらず空文字のまま）でのEscapeは配置自体を取り消す。
    // 既存テキスト編集中のEscapeは、storeをまだ書き換えていないので再描画するだけで元に戻る
    const t = useTraderStore.getState().texts.find(tt => tt.id === stopped.id);
    if (t && t.text === '') useTraderStore.getState().removeText(stopped.id);
    else syncTextsRef.current();
  }

  const startEditingEl = (el: HTMLDivElement) => {
    el.style.pointerEvents = 'auto';
    el.contentEditable = 'true';
    el.style.outline = 'none';
    el.addEventListener('keydown', onTextEditKeyDown);
    el.addEventListener('input', onTextEditInput);
    el.addEventListener('compositionstart', onTextEditCompositionStart);
    el.addEventListener('compositionend', onTextEditCompositionEnd);
    el.addEventListener('blur', finishTextEdit);
    el.focus();
    // カーソルは末尾に置く（全選択のままだと最初のキー入力で全部消えてしまう）
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  // 既存テキストの編集: その実体であるDOM要素をそのまま編集モードにする
  const beginEditExistingText = (id: number) => {
    const el = textElsRef.current.get(id);
    if (!el) return;
    editingTextId = id;
    editingTextEl = el;
    startEditingEl(el);
  };

  // 新規配置: 空文字のDrawnTextをまず追加する（addTextが末尾でselectLineを呼ぶため、
  // 配置と同時に選択状態＝編集モードに入りパレットモードも自動でONになる）。
  // 続けてsyncTextsをその場で呼び、Reactの再描画を待たずに対応するDOM要素を
  // すぐ作らせてから編集モードに入る（フォーカスするには実体が要るため）
  const beginNewTextEdit = (time: number, price: number) => {
    useTraderStore.getState().addText(time, price, '');
    syncTextsRef.current();
    const newId = useTraderStore.getState().nextTextId - 1;
    beginEditExistingText(newId);
  };

  return {
    getEditingTextId: () => editingTextId,
    beginEditExistingText,
    beginNewTextEdit,
  };
}
