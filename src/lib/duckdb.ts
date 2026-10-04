import * as duckdb from '@duckdb/duckdb-wasm';
import type { Candle } from '../types';
import { WEEK_SEC, MONTH_SEC } from '../types';
import { brokerToJST } from './timezone';

let db: duckdb.AsyncDuckDB | null = null;

export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (db) return db;

  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger();

  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  return db;
}

// 一部の証券会社のCSVエクスポートは末尾にDOS由来のEOFマーカー（0x1A = Ctrl-Z）が
// 付いていることがある。DuckDBのCSVパーサーはこれを含むと「state machine reached an
// invalid state」で読み込み全体が失敗する（ignore_errors=trueは行単位の耐性なので、
// この手の壊れたバイト列までは救えない）。
// 末尾の制御文字・空行はCSVの意味上不要なので、安全に取り除いておく
function stripTrailingGarbageBytes(buffer: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(buffer);
  let end = bytes.length;
  while (end > 0) {
    const b = bytes[end - 1];
    if (b === 0x1a || b === 0x00 || b === 0x0a || b === 0x0d) end--;
    else break;
  }
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

// Axiory MT4形式: 2024.01.02,00:01,Open,High,Low,Close,Volume
// 複数ファイルをファイル名順に1本ずつ INSERT（全ファイルを同時にメモリに乗せない）
export async function loadCSVFiles(
  instance: duckdb.AsyncDuckDB,
  files: File[],
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<void> {
  // ファイル名の辞書順でソート（USDJPY_2015_all.csv → ... → USDJPY_2026_04.csv）
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));

  const conn = await instance.connect();
  try {
    await conn.query(`
      CREATE OR REPLACE TABLE candles_1m (
        ts     BIGINT,
        open   DOUBLE,
        high   DOUBLE,
        low    DOUBLE,
        close  DOUBLE,
        volume BIGINT
      )
    `);

    // パイプライン: DuckDB が N 本目を処理している間に N+1 本目を先読み
    let nextBuf: Promise<ArrayBuffer> = sorted[0].arrayBuffer();

    for (let i = 0; i < sorted.length; i++) {
      onProgress?.(i + 1, sorted.length, sorted[i].name);

      const buffer = await nextBuf;

      // 次ファイルの先読みを DuckDB 処理と並行して開始
      if (i + 1 < sorted.length) {
        nextBuf = sorted[i + 1].arrayBuffer();
      }

      await instance.registerFileBuffer('_current.csv', stripTrailingGarbageBytes(buffer));
      await conn.query(`
        INSERT INTO candles_1m
        SELECT
          epoch(strptime(column0 || ' ' || column1, '%Y.%m.%d %H:%M'))::BIGINT AS ts,
          column2::DOUBLE AS open,
          column3::DOUBLE AS high,
          column4::DOUBLE AS low,
          column5::DOUBLE AS close,
          column6::BIGINT  AS volume
        FROM read_csv('_current.csv', header=false, delim=',', all_varchar=true, ignore_errors=true)
      `);
      await instance.dropFile('_current.csv');
    }

    // ソート不要: query4HCandles の GROUP BY + ORDER BY time で整列するため
  } finally {
    await conn.close();
  }
}

// MAE/MFE・決済後の値幅分析用: 複数の時間帯（ブローカー時間のUnix秒範囲、複数トレード分を
// まとめて1クエリで済ませるためのもの）に絞って1分足を取得する。範囲は呼び出し側が数値として
// 計算済みのもの（ユーザー入力ではない）のみを渡す前提で、文字列展開のままSQLに埋め込む
export async function queryCandlesInRanges(
  instance: duckdb.AsyncDuckDB,
  brokerRanges: { lo: number; hi: number }[],
): Promise<Candle[]> {
  if (brokerRanges.length === 0) return [];
  const conn = await instance.connect();
  try {
    const whereClause = brokerRanges
      .map(r => `(ts >= ${Math.floor(r.lo)} AND ts <= ${Math.ceil(r.hi)})`)
      .join(' OR ');
    const result = await conn.query(`
      SELECT
        (floor(ts / 60) * 60)::BIGINT AS time,
        arg_min(open,  ts) AS open,
        max(high)          AS high,
        min(low)           AS low,
        arg_max(close, ts) AS close
      FROM candles_1m
      WHERE ${whereClause}
      GROUP BY floor(ts / 60)
      ORDER BY time
    `);
    return result.toArray().map(row => ({
      time:  brokerToJST(Number(row.time)),
      open:  Number(row.open),
      high:  Number(row.high),
      low:   Number(row.low),
      close: Number(row.close),
    }));
  } finally {
    await conn.close();
  }
}

// intervalSec は固定の時間軸選択肢からのみ渡される（ユーザー入力ではないため文字列展開で安全）
// 週足・月足はカレンダー月/週の日数が一定でないため floor(ts/sec) の等間隔バケットが使えない。
// DuckDB の date_trunc で暦基準（週=月曜始まり, 月=1日始まり）に集計する
export async function queryCandles(instance: duckdb.AsyncDuckDB, intervalSec: number): Promise<Candle[]> {
  const conn = await instance.connect();
  try {
    const bucket =
      intervalSec === WEEK_SEC  ? `date_trunc('week', to_timestamp(ts))` :
      intervalSec === MONTH_SEC ? `date_trunc('month', to_timestamp(ts))` :
      null;
    const timeExpr = bucket ? `epoch(${bucket})` : `floor(ts / ${intervalSec}) * ${intervalSec}`;
    const groupBy = bucket ?? `floor(ts / ${intervalSec})`;
    const result = await conn.query(`
      SELECT
        (${timeExpr})::BIGINT AS time,
        arg_min(open,  ts) AS open,
        max(high)          AS high,
        min(low)           AS low,
        arg_max(close, ts) AS close
      FROM candles_1m
      GROUP BY ${groupBy}
      ORDER BY time
    `);
    // ブローカーのサーバー時間（GMT+2/+3, EU夏時間）→ 日本時間表示に変換
    return result.toArray().map(row => ({
      time:  brokerToJST(Number(row.time)),
      open:  Number(row.open),
      high:  Number(row.high),
      low:   Number(row.low),
      close: Number(row.close),
    }));
  } finally {
    await conn.close();
  }
}
