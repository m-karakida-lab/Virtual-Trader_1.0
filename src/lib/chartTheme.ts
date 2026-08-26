// TradingViewの見た目に合わせたチャート共通スタイル。CandleChart/MiniChart/ChartHeaderで共有する。
import { LineStyle } from 'lightweight-charts';
import type { LineDash } from '../types';

export const CHART_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
export const CHART_AXIS_TEXT_COLOR = '#787b86';
export const CHART_AXIS_FONT_SIZE = 12;

// 水平線・垂直線・四角形（描画ツール）の線種変換。CandleChart/MiniChartで共有する
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

export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
