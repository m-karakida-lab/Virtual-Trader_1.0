// TradingViewの見た目に合わせたチャート共通スタイル。CandleChart/ChartHeaderで共有する。
import { LineStyle } from 'lightweight-charts';
import type { LineDash } from '../types';

export const CHART_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
export const CHART_AXIS_TEXT_COLOR = '#787b86';
export const CHART_AXIS_FONT_SIZE = 12;

// 水平線（描画ツール）の価格ライン用の線種変換
export const DASH_TO_STYLE: Record<LineDash, LineStyle> = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
};

export const DASH_TO_CSS: Record<LineDash, string> = {
  solid: 'solid',
  dashed: 'dashed',
  dotted: 'dotted',
};
