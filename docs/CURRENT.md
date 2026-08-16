# CURRENT

> 「今どうなっているか」だけを書く。経緯は CHANGELOG / git log。判断理由は ADR。
> このファイルは**上書き更新**。"Phase NN" のような時系列ラベルを書かない。

---

## 技術スタック

- **Runtime**: ブラウザ（Vite 5 dev server）
- **Framework**: React 18 + TypeScript 5
- **Build**: Vite 5 + @vitejs/plugin-react
- **チャート**: lightweight-charts 4（TradingView製 ローソク足専用）
- **データ処理**: @duckdb/duckdb-wasm 1.29（ブラウザ内 SQL エンジン）
- **状態管理**: Zustand 4
- **永続化**: CSVデータ・取引状態は永続化なし（リロードで消える）。フォルダブックマークのみ IndexedDB に保存

## 主要機能

### データ読み込み
- Axiory MT4形式 1分足 CSV の読み込み（複数ファイル対応、ファイル名昇順で結合）
- **フォルダブックマーク**（Chrome/Edgeのみ、File System Access API）: 複数フォルダを登録可能。「📁 フォルダを追加」で選んだフォルダを IndexedDB に配列で保存し、配下のCSVを全件自動読み込み。登録済みフォルダは「⚡ {フォルダ名}」チップでワンクリック再読み込み、「✕」でブックマーク解除（個別ファイル選択UIはなし）
- 読み込み完了時は「✓ N本 読み込み完了」を5秒間表示してから消える
- 1分足 → 任意時間軸への自動集計（DuckDB SQL）。**15m / 1H / 4H / 1D を切替可能**
- 通貨記号の自動検出: ファイル名（例 `EURUSD_2025_all.csv`）からクオート通貨を判定し記号表示を切替（実際の円換算はしない、クオート通貨のまま）

### チャート表示・描画
- ローソク足 + **200EMA**（増分計算）、**ボリンジャーバンド**（期間20、ミドル=青実線、±1σ=シルバー点線、±2σ=シルバー実線、増分計算、デフォルトOFF）、**週区切り線**（月曜00:00UTC、控えめなドット線）、ON/OFF切替可
- **水平線・垂直線描画**: クリックで配置、ドラッグで移動、色・線種・太さを個別設定
- **ものさし**: ドラッグで価格差・pips・%・本数・期間・中央線を計測
- 価格軸の表示精度はペアの価格帯から自動判定（JPYクロス=小数3桁、それ以外=小数5桁、TradingViewと同じ`1.17471`形式）
- **全体を見る**（全期間一括表示）/ **画面にフィット**（ズームリセット）/ **日時ジャンプ**（カレンダー、縮尺維持で中心移動）
- **1画面 / 4画面レイアウト切替**: 4画面時はメイン時間軸（操作可能・発注/描画ツールあり）+ 残り3つの時間軸を表示専用ミニチャートとして2×2グリッド表示。ミニチャートはメインのカーソル時刻まで自動で切り詰められ連動する。全パネルの左上に時間軸ラベルを表示

### 再生
- ▶（自動再生・1〜20倍速、`requestAnimationFrame`実装）/ ⏭（1コマ進む）/ ⏮（1コマ戻る、表示のみ・約定は取り消さない）
- **フロート操作パネル**: チャート上にドラッグで自由配置できる再生ボタン群。価格軸・時間軸の領域には重ならないようクランプ
- 再生中は右価格軸の `autoScale` を毎ステップ再有効化し、縦方向のはみ出しを防止

### 発注・トレード
- **成行 / 指値 / 逆指値**を選択して発注。指値・逆指値は現在値との上下関係を検証（不正な方向はエラー表示）
- **TP/SL** を発注時に設定可能。未約定の指値・逆指値にも約定前からTP/SLを表示・ドラッグ調整可能
- TP/SL・指値/逆指値の価格はチャート上で📍ボタンからクリック取得、またはドラッグで調整可能
- **ロット指定**: 固定ロット or **リスク%モード**（残高×リスク% ÷ |エントリー価格-SL| で自動計算、デフォルト3%）
- **リスクリワード（R:R）プレビュー**: draft中のエントリー・TP・SLから値幅を色付きボックスで可視化、比率を表示
- 複数ポジション同時保有可能、個別決済 / 全決済
- **エントリー・決済マーカー**: チャート上に矢印（エントリー）と円（決済、損益付き）を表示。決済済みトレードは `closedTrades` に履歴保存
- **取引履歴パネル**: エクイティカーブ（損益推移の線グラフ）+ 取引一覧テーブル（勝率・合計損益も表示）

### 口座
- 残高・含み損益（ポジション別・合計）のリアルタイム表示
- **初期残高**: 手動設定可能。クオート通貨がJPYなら100万、それ以外（USD等）なら1万がデフォルト（手動変更後は自動調整しない）
- **リセットボタン**: CSV再読込なしで残高・ポジション・履歴を初期化

## データモデル

```ts
Candle       { time: number(Unix秒,UTC), open, high, low, close: number }
Position     { id, side: 'BUY'|'SELL', openPrice, lots, openTime, tp?, sl?: number }
PendingOrder { id, side, type: 'limit'|'stop', price, lots, tp?, sl?: number }
ClosedTrade  { id, side, openPrice, closePrice, openTime, closeTime, lots, pnl: number }
DrawnLine    { id, price, color, dash: 'solid'|'dashed'|'dotted', width: 1|2|3|4 }
DrawnVLine   { id, time, color, dash, width }  // 構造はDrawnLineと同じでpriceがtimeに変わる
LineSelection: { kind: 'h'|'v', id: number } | null
TIMEFRAMES: [{sec:900,label:'15m'}, {sec:3600,label:'1H'}, {sec:14400,label:'4H'}, {sec:86400,label:'1D'}]
```

DuckDB テーブル: `candles_1m`（ts: BIGINT, open/high/low/close: DOUBLE, volume: BIGINT）— 集計元の生データとして保持し続ける

## アーキテクチャ境界

- **プロセス境界**: シングルプロセス（ブラウザのみ）。バックエンドなし
- **DuckDB-wasm**: jsDelivr CDN からバンドル取得。App マウント時に先読み開始
- **状態管理**: Zustand store 1本（`useTraderStore`）+ セレクタ（`selectUnrealizedPnL`, `selectPositionPnL`）
- **永続化**: フォルダハンドルのみ IndexedDB（`src/lib/folderBookmark.ts`）。他は全てメモリ
- **外部 API**: なし（File System Access API はブラウザ機能、外部通信ではない）

## 主要コンポーネント / モジュール責務

- `src/lib/duckdb.ts` — DuckDB 初期化・複数CSV読み込み（パイプライン処理）・任意時間軸集計クエリ
- `src/lib/currency.ts` — ファイル名から通貨ペア検出・通貨記号マッピング
- `src/lib/pips.ts` — 価格帯から pip単位・表示精度を推定（JPYクロス判定）
- `src/lib/folderBookmark.ts` — File System Access API のフォルダハンドル保存/復元（IndexedDB）、CSV一覧取得
- `src/store/useTraderStore.ts` — 全アプリ状態 + アクション。注文約定・TP/SL判定は`processOrderRange`（ローソク足の高安レンジで判定、SL優先）。チャート操作系は「シグナル」パターン（`fitSignal`/`centerSignal` を increment → CandleChart の useEffect が検知）
- `src/components/CandleChart.tsx` — lightweight-charts ラッパー。ローソク足は1コマ前進時`update()`差分更新、それ以外`setData()`。水平線・垂直線・注文・TP/SL・draft値はすべて統一ドラッグシステム（`DragTarget`判別）。垂直線・週区切り線・ものさし・RRプレビューはDOMオーバーレイで自前描画
- `src/components/MiniChart.tsx` — 4画面レイアウトの表示専用パネル。指定時間軸で自前にDuckDB集計し、メインのカーソル時刻までに切り詰めて描画するだけ（発注・描画ツールなし）
- `src/components/Controls.tsx` — 時間軸/表示モード/発注パネル/ポジション・注文一覧/口座情報。描画ツール一式と日時ジャンプは`MenuButton`（クリック開閉のポップアップ、下方向に開く）に集約。常時表示は発注パネルと口座・時間軸などの1行のみ
- `src/components/FloatingControls.tsx` — ドラッグ移動可能な再生ボタン群（チャート領域内にクランプ）
- `src/components/HistoryPanel.tsx` — エクイティカーブ + 取引履歴テーブル（オーバーレイパネル）
- `src/components/FileLoader.tsx` — CSV ファイルピッカー + フォルダブックマーク

## 不変条件 / 地雷

- ボリンジャーバンドはEMA同様、`showBB`がOFFでも裏で計算を継続し`visible:false`で隠すだけ（ON/OFF切替時の再計算漏れを避けるため）。移動窓の合計・二乗和（`bbSumRef`/`bbSumSqRef`）で差分更新し、`recomputeBBFull`は時間軸切替・日時ジャンプ等の非連続更新時のみ呼ぶ
- DuckDB-wasm は SharedArrayBuffer を使うため、Vite dev server に `COOP/COEP` ヘッダが必要（`vite.config.ts` に設定済み）
- `read_csv` に `all_varchar=true` と `ignore_errors=true` が必須
- P&L 計算は**クオート通貨そのまま**（円換算しない）。EURUSDなら結果はUSD相当
- チャートの月境界マークは `tickMarkFormatter` を通らず `localization.dateFormat` が使われる。有効トークンは `yyyy/yy/MMMM/MMM/MM/dd` のみ
- 自動再生は `requestAnimationFrame` で実装（`setInterval` は高速再生時に描画ノイズが出る）
- ドラッグ系操作（水平線・垂直線・ものさし・注文・TP/SL・draft）は開始時にチャートの `handleScroll`/`handleScale` を無効化し、終了時に必ず再有効化する。新規ドラッグ操作追加時はこの作法に従う
- 水平線・垂直線・TP/SL・draft価格は丸めない（量子化するとズーム次第でカクつく）。表示側のみ `toFixed(pricePrecision(price))`
- DOMオーバーレイ（垂直線・週区切り線・ものさし・RRプレビュー）は `z-index` 10〜13 を使用。新規追加時はこの範囲を踏まえること
- `processOrderRange` は1本ずつ順に処理し、同一バーでTP/SL両方ヒット時はSLを優先（保守的判定）。`advance()`は1本、`jumpToTime()`は前進時のみ通過範囲を遡って判定（後退ジャンプは判定しない）
- チャート操作（`fitToScreen`/`centerOnTime`等）はシグナルincrement + useEffectの実行順に依存。`centerSignal`のeffectはリプレイモードのcursor effectより**後**に置くこと（先に置くと`scrollToRealTime()`に上書きされる）
- CSV再読込で `lines`/`vlines`/`closedTrades`/`positions`/`pendingOrders` は全リセット。時間軸切替では保持
- フォルダブックマークは Chrome/Edge のみ対応（File System Access API）。Safari/Firefoxでは機能自体が非表示になる
- フロートパネルの位置クランプは `chart.priceScale('right').width()` / `chart.timeScale().height()` の実測値をストア経由で共有している。チャートのリサイズ・精度変更時に更新される
- `FloatingControls` は `offsetParent`（直近の`position:relative`祖先）基準でクランプする。1画面・4画面どちらでもチャート表示欄全体（`App.tsx`のflex:1コンテナ）が親なので、4画面時もメインパネル以外の領域に自由に移動できる
- `MiniChart` はカーソル進行のたびに `fitContent()` すると、序盤は本数が少なく1本だけが画面幅いっぱいに拡大されてしまう。新しいデータセット（時間軸切替・CSV再読込）に切り替わった時だけ全期間の時間幅で `setVisibleRange()` し、以降カーソルが進んでもスケールは固定したまま本数だけ増える
- `MenuButton`（`Controls.tsx`）のポップアップは下部バーの上方向に開き、`right: 0` 基準で右揃え配置。ボタンが画面右寄りにある前提の実装なので、左寄りのボタンに使う場合は配置を見直すこと

## ビルド / 起動

```bash
# dev（初回のみ npm install）
npm install
npm run dev       # http://localhost:5173/

# 型チェック
npm run typecheck
```

## TODO / 既知の不具合

- DuckDB バンドルの CDN 依存（オフライン不可）
- セッション永続化なし（リロードで CSV 再読み込みが必要。フォルダブックマークのみ復元可）
- 高速再生（20x）時にヒゲ部分のちらつきが残る場合がある（実害小、保留中）
- 非JPYクオートペアの損益は実際の円換算をしていない（クオート通貨のまま表示）
