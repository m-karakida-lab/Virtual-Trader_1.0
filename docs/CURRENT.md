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
- **永続化**: CSVデータ・取引状態は永続化なし（リロードで消える）。フォルダブックマークは IndexedDB、チャートのズーム/スケールと再生速度は localStorage に保存
- **デフォルト**: 4画面レイアウト・メイン時間軸15m。インジケーターはBB・雲・区切り線がON、EMA200はOFF

## 主要機能

### データ読み込み
- Axiory MT4形式 1分足 CSV の読み込み（複数ファイル対応、ファイル名昇順で結合）
- **フォルダブックマーク**（Chrome/Edgeのみ、File System Access API）: 複数フォルダを登録可能。「📁 フォルダを追加」で選んだフォルダを IndexedDB に配列で保存し、配下のCSVを全件自動読み込み。登録済みフォルダは「⚡ {フォルダ名}」チップでワンクリック再読み込み、「✕」でブックマーク解除（個別ファイル選択UIはなし）
- 読み込み完了時は「✓ N本 読み込み完了」を5秒間表示してから消える
- 1分足 → 任意時間軸への自動集計（DuckDB SQL）。**15m / 1H / 4H / 1D / 1W / MN を切替可能**。週足・月足はカレンダー基準（週=月曜始まり、月=1日始まり）で`date_trunc`集計、それ以外は`floor(ts/sec)`の固定長バケット集計
- **表示は日本時間(JST)に変換済み**: CSV（Axiory MT4形式）のブローカーサーバー時間はEU夏時間ルール（GMT+2冬/GMT+3夏）に従う前提で自動変換。チャート・日時ジャンプ・取引履歴など全表示箇所がJST基準
- 通貨記号の自動検出: ファイル名（例 `EURUSD_2025_all.csv`）からクオート通貨を判定し記号表示を切替（実際の円換算はしない、クオート通貨のまま）

### チャート表示・描画
- ローソク足 + **200EMA**（増分計算、デフォルトOFF）、**SMA14**（単純移動平均、増分計算、デフォルトOFF）、**ボリンジャーバンド**（期間20、ミドル=青実線、±1σ=シルバー点線、±2σ=シルバー実線、増分計算、デフォルトON）、**一目均衡表の雲**（先行スパンA/Bのみ、26**本**先行、色分け塗りつぶし、デフォルトON）、**区間区切り**（15m/1Hは日替わり、4Hは週替わり、1D/1Wは月替わり、MNは年替わりで最初に出現した足の時刻を境界とする、控えめなドット線、デフォルトON）、ON/OFF切替可。これらはすべて4画面時のミニチャート3枚にも連動して反映される（`src/lib/indicators.ts`・`src/lib/weekLines.ts`を共有）
- **水平線・垂直線描画**: クリックで配置、ドラッグで移動、色・線種・太さを個別設定
- **四角形描画**: ドラッグで描画（始点〜終点の対角）。色は青・赤・黄・緑の4色、太さ1〜4pxを個別設定。4隅のいずれかをドラッグしてリサイズ可能（反対側の角は固定、掴んだ角だけ移動）。選択中（`描画`メニュー内の一覧をクリック）にDelete/Backspaceキーで削除（水平線・垂直線も同様）。配置後の平行移動は非対応。水平線・垂直線・四角形とも、描画・編集操作はメインパネルのみだが、表示自体は4画面のミニチャート3枚にも常時同期される
- **ものさし**: ドラッグで価格差・pips・%・本数・期間・中央線を計測
- 価格軸の表示精度はペアの価格帯から自動判定（JPYクロス=小数3桁、それ以外=小数5桁、TradingViewと同じ`1.17471`形式）
- **全体を見る**（全期間一括表示）/ **画面にフィット**（ズームリセット）/ **最新足に固定**（メインパネルの縮尺は維持したまま最新足を右オフセット位置に表示、`scrollToRealTime()`）/ **日時ジャンプ**（カレンダー、縮尺維持で中心移動）
- **1画面 / 4画面レイアウト切替**: 4画面時は枠の位置（左上・左下・右上・右下）は固定、各枠に表示する時間軸はユーザーが選べる（デフォルトは左上15m・左下1H・右上4H・右下1D）。各パネル左上のヘッダーの時間軸表示をクリックするとTradingView風のドロップダウンが開き、その場で時間軸を切り替えられる。操作可能なメインパネル（発注/描画ツールあり）の枠は、下部の時間軸ボタン・パネルヘッダーのドロップダウン・ミニチャートのクリックのいずれでも切替可能。ミニパネルのドロップダウンで時間軸を変えても表示専用のままメインには昇格しない（メインへの昇格はパネル本体のクリックのみ）。ミニチャートは自分の足が完全に閉じた時点で初めて表示（先出し防止、メインのカーソル進行に連動）。各枠の時間軸の組み合わせとメイン枠の位置はlocalStorageに記憶（`vt:quad`）。ただしメイン時間軸自体は他の設定と違い再起動時に常にデフォルト15mへ戻るため、メイン枠の中身もそれに揃える
- **TradingView風パネルヘッダー**: 各チャート左上に「シンボル（ファイル名から検出） + 時間足」を表示。軸フォントもTradingView寄りのサンセリフに統一（`src/lib/chartTheme.ts`）
- **ズーム/スケールの記憶**: 時間軸ごとにパン・ズーム位置をlocalStorageに保存し、次回そのCSVに限らずどのデータを読み込んでも同じ拡大率で復元。ただしパン位置（右端からの距離）は復元せず、メインパネルは常に最新足に固定（縮尺だけ記憶を引き継ぎ、表示位置は都度「最新足に固定」を自動実行）。CSV読み込み直後・時間軸切替の両方で自動的に働く。1画面のメインパネルと4画面のミニチャートそれぞれ独立して記憶する
- **4画面時の十字カーソル同期**: いずれか1枚のパネルを実際にマウスホバーすると、他の3枚にも同じ時刻の位置に十字カーソルを表示する（`chart.setCrosshairPosition`）。価格は各パネル自身のその時刻直前の終値を使う。ホバー元のパネルから外れると全パネルで消える（`src/lib/crosshairSync.ts`・`src/store/useTraderStore.ts`の`crosshairSourceId`/`crosshairTime`を共有）。ホバー中の時刻がそのパネルにまだ存在しない（先出し防止でまだ見えていない未来、または一番古い足より前）場合は、無関係な位置にスナップ表示せず何も表示しない

### 再生
- ▶（自動再生・1〜20倍速、`requestAnimationFrame`実装、速度はlocalStorageに記憶して次回起動時も引き継ぐ）/ ⏭（1コマ進む）/ ⏮（1コマ戻る、表示のみ・約定は取り消さない）
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
DrawnRect    { id, time1, price1, time2, price2, color, width: 1|2|3|4 }  // 色は青・赤・黄の3色固定、dashなし
LineSelection: { kind: 'h'|'v'|'rect', id: number } | null
TIMEFRAMES: [{sec:900,label:'15m'}, {sec:3600,label:'1H'}, {sec:14400,label:'4H'}, {sec:86400,label:'1D'}, {sec:604800,label:'1W'}, {sec:2629746,label:'MN'}]
// MNのsecは平均月長（秒）で近似値。DB集計は実際の暦月でdate_trunc、この値はcursorEnd等の「おおよその足の長さ」計算にのみ使う
```

DuckDB テーブル: `candles_1m`（ts: BIGINT, open/high/low/close: DOUBLE, volume: BIGINT）— 集計元の生データとして保持し続ける

## アーキテクチャ境界

- **プロセス境界**: シングルプロセス（ブラウザのみ）。バックエンドなし
- **DuckDB-wasm**: jsDelivr CDN からバンドル取得。App マウント時に先読み開始
- **状態管理**: Zustand store 1本（`useTraderStore`）+ セレクタ（`selectUnrealizedPnL`, `selectPositionPnL`）
- **永続化**: フォルダハンドルのみ IndexedDB（`src/lib/folderBookmark.ts`）。他は全てメモリ
- **外部 API**: なし（File System Access API はブラウザ機能、外部通信ではない）

## 主要コンポーネント / モジュール責務

- `src/lib/duckdb.ts` — DuckDB 初期化・複数CSV読み込み（パイプライン処理）・任意時間軸集計クエリ（`queryCandles`の戻り値は`brokerToJST`でJST変換済み。週足/月足は`date_trunc`、それ以外は`floor(ts/sec)`で集計）
- `src/lib/timezone.ts` — CSVのブローカーサーバー時間（GMT+2冬/GMT+3夏、EU夏時間ルール）→ JSTへの変換
- `src/lib/currency.ts` — ファイル名から通貨ペア検出（`detectPairSymbol`）・クオート通貨/記号マッピング
- `src/lib/chartTheme.ts` — TradingView風のチャート共通スタイル定数（フォント・軸文字色/サイズ）
- `src/lib/chartViewState.ts` — チャートのズーム/スケールを時間軸ごとにlocalStorageへ保存/復元。絶対時刻ではなく「右端から何本目〜何本分」の相対位置で持つため、別データセットでも同じ拡大率で再現される
- `src/lib/indicators.ts` — EMA/SMA/BB/雲の計算ロジック（全体再計算版）。MiniChartが使用。CandleChartは増分計算の最適化版を別途持つ。ただし雲のずらし先時刻を返す`cloudDisplacedTime`だけは CandleChart / MiniChart 双方がここを共用する（本数ベースでずらす実装を1箇所に閉じるため）
- `src/lib/weekLines.ts` — 区間区切りの境界計算（`computeSeparatorBoundaries`。MN足は`computeYearBoundaries`＝年区切り、1D/1W足は`computeMonthBoundaries`＝月区切り、4H足は`computeWeekBoundaries`＝週区切り（月曜始まり）、15m/1Hは`computeDayBoundaries`＝日区切り）。CandleChart/MiniChart共通
- `src/lib/pips.ts` — 価格帯から pip単位・表示精度を推定（JPYクロス判定）
- `src/lib/crosshairSync.ts` — 4画面の十字カーソル同期用。`priceAtTime(candles, time, timeframeSec)`で、指定時刻直前に確定している足の終値を返す。時刻が先頭の足より前、または末尾の足の期間（`time + timeframeSec`）を超える場合はnull（そのパネルにはまだ存在しない未来のためクロスヘアを出さない）
- `src/lib/folderBookmark.ts` — File System Access API のフォルダハンドル保存/復元（IndexedDB）、CSV一覧取得
- `src/store/useTraderStore.ts` — 全アプリ状態 + アクション。注文約定・TP/SL判定は`processOrderRange`（ローソク足の高安レンジで判定、SL優先）。チャート操作系は「シグナル」パターン（`fitSignal`/`centerSignal`/`scrollToLatestSignal` を increment → CandleChart の useEffect が検知）
- `src/components/CandleChart.tsx` — lightweight-charts ラッパー。ローソク足は1コマ前進時`update()`差分更新、それ以外`setData()`。水平線・垂直線・注文・TP/SL・draft値はすべて統一ドラッグシステム（`DragTarget`判別）。垂直線・区切り線・ものさし・RRプレビューはDOMオーバーレイで自前描画。雲（先行スパンA/B間）の塗りつぶしは`<canvas>`オーバーレイに自前描画
- `src/components/MiniChart.tsx` — 4画面レイアウトの表示専用パネル。指定時間軸で自前にDuckDB集計し、メインの現在足が閉じた時刻までに切り詰めて描画するだけ（発注・描画ツールなし）。EMA/BB/雲・区切り線はメインパネルのON/OFF設定に連動して同じものを表示。パネル本体クリックでその時間軸をメインパネルに切り替え可能（`mousedown`/`mouseup`の移動量で判定し、パン/ズームのドラッグとは区別）。ヘッダーの時間軸ドロップダウン（`ChartHeader`）から選ぶとメインには昇格せず、この枠の表示時間軸だけが変わる
- `src/components/ChartHeader.tsx` — パネル左上の「シンボル + 時間軸」表示。`onSelectTimeframe`を渡すとTradingView風のクリック開閉ドロップダウンになる（CandleChart/MiniChart共通、選択時の挙動は呼び出し側が決める）
- `src/components/Controls.tsx` — 時間軸/表示モード/発注パネル/ポジション・注文一覧/口座情報。発注パネル・描画ツール一式・日時ジャンプは`MenuButton`（クリック開閉のポップアップ、下方向に開く）に集約。常時表示は口座・時間軸などの1行のみ（保有ポジション・未約定注文の一覧はある時だけ常時表示）
- `src/components/FloatingControls.tsx` — ドラッグ移動可能な再生ボタン群（チャート領域内にクランプ）
- `src/components/HistoryPanel.tsx` — エクイティカーブ + 取引履歴テーブル（オーバーレイパネル）
- `src/components/FileLoader.tsx` — CSV ファイルピッカー + フォルダブックマーク
- `src/components/ErrorBoundary.tsx` — レンダー/エフェクト中の例外を捕捉し、黒画面の代わりにエラー内容と直近のエラー履歴を表示する（`main.tsx`でAppを包む）
- `src/lib/errorLog.ts` — 例外をlocalStorage（`vt:errorLog`、直近20件）に記録する。`window.onerror`/`unhandledrejection`（`main.tsx`）とErrorBoundaryの両方から書き込む。原因不明の不具合を後から追跡するための仕組み

## 不変条件 / 地雷

- ボリンジャーバンドはEMA同様、`showBB`がOFFでも裏で計算を継続し`visible:false`で隠すだけ（ON/OFF切替時の再計算漏れを避けるため）。移動窓の合計・二乗和（`bbSumRef`/`bbSumSqRef`）で差分更新し、`recomputeBBFull`は時間軸切替・日時ジャンプ等の非連続更新時のみ呼ぶ
- DuckDB-wasm は SharedArrayBuffer を使うため、Vite dev server に `COOP/COEP` ヘッダが必要（`vite.config.ts` に設定済み）
- `read_csv` に `all_varchar=true` と `ignore_errors=true` が必須
- P&L 計算は**クオート通貨そのまま**（円換算しない）。EURUSDなら結果はUSD相当
- JST変換は`candles_1m`（生の1分足）ではなく`queryCandles`の集計結果（`time`列）に対して事後的に適用している。そのため4H/1D等のバケット境界自体はブローカー時間基準のまま（JST 00:00ちょうど等の切りの良い時刻にはならない）。ラベルの変換のみで再集計はしていない。この影響で「計算上のカレンダー時刻（月曜0時等）」を直接使う機能は実在する足の時刻と一致せず`timeToCoordinate`がnullを返しやすい。区切り線は「日/月替わりを跨いだ実際の足」を境界に使うことで回避している（`computeSeparatorBoundaries`）。同種の機能を追加する際はこのパターンを踏襲すること
- チャートの時間軸の目盛りは**そのチャートに載っている全シリーズの時刻の和集合**。ローソク足に存在しない時刻を1つでも持ち込むと、そこに空スロットが挿入されて足が途切れて見える（`visible:false`のシリーズも時刻は残るのでインジケーターをOFFにしても消えない）。一目均衡表の先行スパンは必ず**本数**でずらすこと（`cloudDisplacedTime`）。時刻に`26*timeframeSec`秒を足すと、週末・DST・MN足の平均月秒（`MONTH_SEC`は近似値だが実際の集計は暦月`date_trunc`）のせいで足の無い時刻に着地する。データ終端より先だけは実在の足が無いので等間隔で外挿してよい（全足より右にしか出ないため途中に隙間を作らない）が、実在の足があるうちに外挿してはいけない（後から足が埋まると外挿分が中間に取り残される）
- チャートの月境界マークは `tickMarkFormatter` を通らず `localization.dateFormat` が使われる。有効トークンは `yyyy/yy/MMMM/MMM/MM/dd` のみ
- 自動再生は `requestAnimationFrame` で実装（`setInterval` は高速再生時に描画ノイズが出る）
- ドラッグ系操作（水平線・垂直線・ものさし・注文・TP/SL・draft）は開始時にチャートの `handleScroll`/`handleScale` を無効化し、終了時に必ず再有効化する。新規ドラッグ操作追加時はこの作法に従う
- 水平線・垂直線・TP/SL・draft価格は丸めない（量子化するとズーム次第でカクつく）。表示側のみ `toFixed(pricePrecision(price))`
- DOMオーバーレイ（垂直線・区切り線・ものさし・RRプレビュー）は `z-index` 10〜13 を使用。新規追加時はこの範囲を踏まえること。雲の`<canvas>`は`z-index: 5`（他オーバーレイより背面、ただし実装上lightweight-charts本体の描画canvasより手前になるためローソク足の上に半透明で重なる）
- 雲の塗りつぶしは`timeToCoordinate`で座標変換しているが、表示範囲（ズーム位置の復元・パン等）がローソク足の実データ範囲より外側に及ぶと、範囲外の時刻も外挿されて不自然な塊が描画されてしまう。ローソク足の最初の本（`candles[0].time`）より左側には描画しないようガードしている
- `centerOnTime`（日時ジャンプ・垂直線クリックでの中心移動）は**時刻ベースではなく足のインデックス（logical range）で**計算すること。`getVisibleRange()`/`setVisibleRange()`（時刻ベース）は、読み込み直後など一度もズームしていない状態（表示幅が極端に狭い）で使うと、その狭い幅をそのまま維持してジャンプしてしまい、ローソク足がほぼ表示されない状態になる。`getVisibleLogicalRange()`/`setVisibleLogicalRange()`＋最小表示本数（`MIN_JUMP_SPAN_BARS`）で計算すれば安定する
- `processOrderRange` は1本ずつ順に処理し、同一バーでTP/SL両方ヒット時はSLを優先（保守的判定）。`advance()`は1本、`jumpToTime()`は前進時のみ通過範囲を遡って判定（後退ジャンプは判定しない）
- チャート操作（`fitToScreen`/`centerOnTime`等）はシグナルincrement + useEffectの実行順に依存。`centerSignal`のeffectはリプレイモードのcursor effectより**後**に置くこと（先に置くと`scrollToRealTime()`に上書きされる）。ズーム/スケール復元のeffectも同じ理由でリプレイモードのcursor effectより後に置く
- ズーム/スケールの保存は「表示中の本数」を基準に相対化するため、リプレイモード中は`candles.length`ではなく`cursor + 1`（実際にsetDataされている本数）を使うこと。`candles.length`を使うと未来分を含めてズーム率がずれる
- CSV読み込み直後（`cursor === 0`）は表示本数が1本しかないため、以前保存した（本数の多い時の）ズーム幅`span`をそのまま`relativeViewToLogicalRange`に渡すと、範囲外に大きくはみ出た破綻したlogical range（例: `{from:-95, to:10}`）になる。`scrollToRealTime()`はパン位置しか動かさないためこの破綻したズーム幅は直せない。`saved.span <= totalBars`のときだけ復元を適用するガードで回避している
- CSV再読込で `lines`/`vlines`/`rects`/`closedTrades`/`positions`/`pendingOrders` は全リセット。時間軸切替では保持
- フォルダブックマークは Chrome/Edge のみ対応（File System Access API）。Safari/Firefoxでは機能自体が非表示になる
- フロートパネルの位置クランプは `chart.priceScale('right').width()` / `chart.timeScale().height()` の実測値をストア経由で共有している。チャートのリサイズ・精度変更時に更新される
- `setTimeframe`（4画面メインパネル切替・時間軸ボタン）でのカーソル復元は、新しい足の**終了時刻**が旧カーソル足の終了時刻以下かで選ぶこと（`newCandles[i].time + sec <= currentClose`）。開始時刻だけで比較すると、切替先の未確定（まだ閉じていない）足が選ばれてしまい、切替直後にローソク足が1本先出しで進んで見える
- `FloatingControls` は `offsetParent`（直近の`position:relative`祖先）基準でクランプする。1画面・4画面どちらでもチャート表示欄全体（`App.tsx`のflex:1コンテナ）が親なので、4画面時もメインパネル以外の領域に自由に移動できる
- `MiniChart`/`CandleChart`のルート`<div>`は`width/height: 100%`を明示すること。CSS gridの直接の子であれば指定なしでも自動的に伸びるが、`App.tsx`側で位置固定用に`<div>`でラップしている（`gridRow`/`gridColumn`はラッパー側が持つ）ため、中身のコンポーネント自身も明示的に100%を指定しないと高さ0になって何も描画されない
- `MiniChart` はカーソル進行のたびに `fitContent()` すると、序盤は本数が少なく1本だけが画面幅いっぱいに拡大されてしまう。新しいデータセット（時間軸切替・CSV再読込）に切り替わった時だけ全期間の時間幅で `setVisibleRange()` し、以降カーソルが進んでもスケールは固定したまま本数だけ増える
- `MiniChart` は「バケット終了時刻 ≤ メインの現在足の終了時刻（`cursorTime + mainTimeframeSec`）」の足だけを表示する。単純に`足の開始時刻 ≤ cursorTime`で切り詰めると、進行中の上位足バケットがDuckDB側で先に完成集計されているため、まだ閉じていない足の確定値（先出し/lookahead）を見せてしまう
- `MenuButton`（`Controls.tsx`）のポップアップは下部バーの上方向に開き、`right: 0` 基準で右揃え配置。ボタンが画面右寄りにある前提の実装なので、左寄りのボタンに使う場合は配置を見直すこと
- `CandleChart`の`priceLineMapRef`等7つの`IPriceLine`マップ（水平線・注文・TP/SL・draft）は、チャート初期化effectのクリーンアップ（`chart.remove()`）で必ず`.clear()`すること。マップ自体はrefで永続するため、`chart.remove()`だけだと古い`IPriceLine`（破棄済みseriesに属する）が残り、次のマウント（React StrictModeの二重実行や、4画面でメインパネルが切り替わって`CandleChart`が別枠に再マウントする場合）で`applyOptions()`を呼ぶと`Cannot read properties of undefined (reading '_internal_state')`でクラッシュする
- 4画面の各枠の時間軸（`quadTimeframes`/`quadMainSlot`）は`vt:quad`にlocalStorage保存するが、メイン時間軸（`timeframeSec`）自体は再生速度等と違い永続化せず起動のたびに`DEFAULT_TIMEFRAME`(15m)に戻る。この不整合を防ぐため、保存データ読み込み時に必ず`quadTimeframes[quadMainSlot] = DEFAULT_TIMEFRAME`で上書きしてから使うこと（`loadSavedQuad`内で実施済み）
- `ChartHeader`のクリック可能領域（時間軸ドロップダウン）は、lightweight-chartsが`containerRef`内に自前で挿入する内部canvasと同じz-index帯（内部canvasはz-index:2）を避けること。同値だとDOM順序（内部canvasの方が後に挿入される）でチャート側が上に来て実クリックを奪う。DevToolsやJSでのdispatchEventは要素へ直接発火するため気づきにくく、`document.elementFromPoint`で実際に最前面の要素を確認すること
- 十字カーソル同期（`crosshairSourceId`/`crosshairTime`）で、他パネルが`setCrosshairPosition`をプログラム的に呼んだ際の`subscribeCrosshairMove`コールバックには`param.sourceEvent`が付かない。これを使って「実マウス操作か、同期表示による再発火か」を判定し無限ループを防いでいる。ただしマウスが画面外に抜けた場合の「消える」イベントは`sourceEvent`の有無が信頼できないことがあるため、パネルのルート要素に`onMouseLeave`（Reactの通常のマウスイベント）を別途つけて、自分がホバー元（`crosshairSourceId === 自分のID`）のときだけ明示的にクリアしている
- `chart.setCrosshairPosition(price, time, series)`に、そのパネルの実データ範囲外の時刻を渡しても例外にはならず、無関係などこかの足へ無言でスナップする（例外もconsole警告も出ない）。4画面で各パネルの時間軸・先出し防止のカバー範囲がバラバラなことと組み合わさると、パネルごとに全く違う日時に十字カーソルが出て「同期がずれている」ように見える。`priceAtTime`側で範囲外ならnullを返し、呼び出し側はnullなら`setCrosshairPosition`を呼ばず`clearCrosshairPosition`するガードが必須
- `CandleChart`の`series.createPriceLine`/`applyOptions`/`setCrosshairPosition`など、lightweight-chartsのchart/series APIを呼ぶeffectはすべてtry/catchで包み、失敗したら`errorLog.ts`に記録して処理を継続すること（画面全体をクラッシュさせない）。4画面でパネルを連続で素早く切り替える（`promoteSlotToMain`や時間軸ボタン）と、チャートが破棄されかけているタイミングでこれらのAPIが`Cannot read properties of undefined (reading '_internal_state')`を投げることがある。React にはこの種の例外用の公式なガード方法がなく、`ErrorBoundary`が無いと例外1つでアプリ全体が真っ黒になる（Reactツリーがアンマウントされる）。原因を完全には特定できていない前提で、まずクラッシュさせないことを優先している
- 上記と同じエラー（`series.createPriceLine`起因、TP/SL価格ライン効果）は、try/catchで包んでいても`window.onerror`に漏れて`errorLog`に記録されることがある。lightweight-charts内部で描画が次フレームへ遅延されており、そのタイミングでchartが破棄済みだと同期のtry/catchのスコープ外で例外が飛ぶためと見られる。ただしこのケースはReactツリーの外側で起きる素のJSエラーなので**ErrorBoundaryは発火せず、アプリは壊れず動作を続ける**（クラッシュではなくログに残るだけ）。動作確認時にこのエラーだけが出ても、画面が実際に固まっていなければ気にしなくてよい
- Vite dev serverは、ファイル編集後に`preview_start`していた既存プロセスを使い回すと、依存最適化キャッシュ絡みで編集が反映されない（実際のファイル内容とズレたスタックトレースが出る）ことがある。挙動がおかしいと感じたら、まず`preview_stop`→`preview_start`でプロセスごと再起動して切り分けること
- 四角形描画の座標→時刻変換（`CandleChart`の`pixelToTime`）は、あえて`coordinateToTime`をそのまま使うだけのシンプルな実装にしている。過去に`coordinateToLogical`＋線形補間や`getVisibleRange`ベースの独自スケール計算で「足へのスナップを回避」しようとしたが、リプレイ中の表示範囲（cursorまでしかsetDataされていない）との食い違いや、表示中の足が1本だけの時の範囲・スケール不定などでかえって不安定になった（描画できたりできなかったり、意図と全く違う位置に飛ぶ）。`coordinateToTime`が範囲外で返す`null`だけ、表示中（リプレイ中は`candles.slice(0, cursor+1)`、全表示中は全体）の最初/最後の足の時刻にクランプしている。ドラッグ幅が1本未満だと四角形が細くなるが、それは仕様として許容する（足へのスナップを避けようとする独自スケール計算は再度やらないこと）
- 逆に描画済みの水平線・垂直線・四角形を**表示する**側（`timeToCoordinate`）は「時刻が実在する足と完全一致しないと`null`を返す」ため、時間軸切替（例: 15m→4H）で保存済みの`time`が新しい足のグリッドと一致せず、要素が消えたように見える罠がある。`CandleChart`の`timeToX`ヘルパーで、完全一致しなければ表示中の足を挟む2本の座標を線形補間して求めることで回避している（`vlines`/`rects`の描画・当たり判定は全てこれ経由にすること。ライブドラッグ中の一時的な計算など、同一時間軸内で必ず実在する足の時刻だけを扱う箇所は素の`timeToCoordinate`のままでよい）
- Delete/Backspaceでの図形削除（`CandleChart`の`onKeyDown`）は`e.key === 'Delete'`だけでなく`'Backspace'`も拾うこと。Macの物理削除キーは通常`⌫`＝Backspaceで、`Delete`はfn+⌫が必要なため、`Delete`のみだと大半のユーザーの操作を無視してしまう。なお図形の選択（`selected`）はキャンバス上のクリックでは行われず、`描画`メニュー内の一覧（例:「四角1」）をクリックして選ぶ方式
- 4画面レイアウトでは`quadMainSlot`の1枠だけが`CandleChart`（操作可能・描画ツール持ち）で、残り3枠は`MiniChart`（表示専用）。水平線・垂直線・四角形は元々`MiniChart`に描画コードが一切無かったため、メインパネルを切り替える（別の枠をクリックしてpromoteSlotToMain）と、描いた図形がその枠にしか無いように見えて「消えた」と誤解されていた。`MiniChart`にも`CandleChart`と同じ`timeToX`＋DOMオーバーレイ（vlines/rects）と`createPriceLine`（hlines、`lines`）を追加し、4枠すべてに常時表示するようにした。表示専用なのでドラッグ・選択・削除のハンドラは持たない。新しく描画系オブジェクトの種類を追加する場合は`CandleChart`と`MiniChart`の両方に実装すること（スタイル変換ヘルパー`DASH_TO_STYLE`/`DASH_TO_CSS`/`hexToRgba`は`lib/chartTheme.ts`に共通化済み）

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
