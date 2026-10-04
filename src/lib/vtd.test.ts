import { describe, expect, it } from 'vitest';
import { buildVtdBundle, splitVtdBundle, type VtdDrawings } from './vtd';

const empty = (over: Partial<VtdDrawings> = {}): VtdDrawings => ({
  lines: [], vlines: [], rects: [], trendLines: [], channels: [], arrows: [], brushes: [], texts: [], closedTrades: [], ...over,
});
const CSV = '2016.01.04,00:00,1,2,0.5,1.5,10\n2016.01.04,00:01,1.5,2,1,1.2,5\n';

describe('vtdバンドル', () => {
  it('書き出して読み戻すと、CSVも描画データも同じ', () => {
    const drawings = empty({
      lines: [{ id: 3, price: 110.5, color: '#fff', dash: 'solid', width: 1 }],
      closedTrades: [{ id: 1, side: 'BUY', openPrice: 100, closePrice: 101, openTime: 10, closeTime: 20, lots: 1000, pnl: 1000, memo: 'メモ', rrImage: 'data:image/webp;base64,AAA' }],
      cursorTime: 1451865600,
    });
    const r = splitVtdBundle(buildVtdBundle(CSV, drawings));
    expect(r.csvText).toBe(CSV);
    expect(r.drawings).toEqual(drawings);
  });

  it('マーカーの無い素のCSVはそのまま返り、描画はnull', () => {
    const r = splitVtdBundle(CSV);
    expect(r.csvText).toBe(CSV);
    expect(r.drawings).toBeNull();
  });

  it('古い形式（後から増えたフィールドが無い）は空配列・undefinedで補う', () => {
    const old = CSV + '\n===VT_DRAWINGS_V1===\n' + JSON.stringify({ lines: [], vlines: [], rects: [] });
    const r = splitVtdBundle(old);
    expect(r.drawings).not.toBeNull();
    expect(r.drawings?.trendLines).toEqual([]);
    expect(r.drawings?.channels).toEqual([]);
    expect(r.drawings?.closedTrades).toEqual([]);
    expect(r.drawings?.cursorTime).toBeUndefined();
  });

  it('末尾のJSONが壊れていてもCSV部分は活かす', () => {
    const broken = CSV + '\n===VT_DRAWINGS_V1===\n{"lines": [';
    const r = splitVtdBundle(broken);
    expect(r.csvText).toBe(CSV);
    expect(r.drawings).toBeNull();
  });
});
