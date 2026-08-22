const CURRENCY_SYMBOLS: Record<string, string> = {
  JPY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  NZD: 'NZ$',
  CAD: 'C$',
  CHF: 'Fr',
};

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

// ファイル名から通貨ペア（例: "EURUSD_2025_all.csv" → "EURUSD"）を抽出し、
// クオート通貨（後半3文字）を返す。検出できなければ JPY にフォールバック。
export function detectQuoteCurrency(filename: string): string {
  const match = filename.toUpperCase().match(/([A-Z]{6})/);
  return match ? match[1].slice(3) : 'JPY';
}

// ファイル名から通貨ペアの6文字シンボル（例: "USDJPY"）を抽出。検出できなければ空文字。
export function detectPairSymbol(filename: string): string {
  const match = filename.toUpperCase().match(/([A-Z]{6})/);
  return match ? match[1] : '';
}
