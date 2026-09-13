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
- **永続化**: CSVデータ・取引状態は永続化なし（リロードで消える）。ファイルを開いた履歴は IndexedDB、チャートのズーム/スケールと再生速度は localStorage に保存
- **デフォルト**: 初回起動時は4画面レイアウト・メイン時間軸15m（2回目以降は1画面/4画面の選択とメイン時間軸を記憶）。インジケーターはBB・雲・区切り線がON、EMA200はOFF

## 主要機能

### データ読み込み
- Axiory MT4形式 1分足CSVの読み込み（複数ファイル対応、ファイル名昇順で結合）
- ドラッグ&ドロップ読み込み対応（`App.tsx`の`loadFiles`）。この経路はフォルダ履歴には残らない
- フォルダを開いた履歴（Chrome/Edgeのみ、File System Access API、最大12件、`src/lib/openHistory.ts`、IndexedDB保存）。「ファイル選択▾」から直接ファイル選択／フォルダ選択／履歴選択ができる。非対応ブラウザは`<input type=file>`にフォールバックし履歴機能自体出ない
- 読込完了時「✓ N本 読み込み完了」を5秒間表示
- 1分足→任意時間軸への自動集計（DuckDB SQL）。15m/1H/4H/1D/1W/MN切替可。週足・月足はカレンダー基準`date_trunc`集計、それ以外は`floor(ts/sec)`固定長バケット集計
- 表示は日本時間(JST)に変換済み。CSV（ブローカーサーバー時間）はEU夏時間ルール（GMT+2冬/+3夏）前提で自動変換。チャート・日付ジャンプ・取引履歴すべてJST基準
- 通貨記号はファイル名（例`EURUSD_2025_all.csv`）から自動検出。実際の円換算はしない
- 書き込み（水平線・垂直線・四角形・トレンドライン・ブラシ・テキスト）の保存/読込: 単一ファイル読込時のみ「💾 vtd保存」ボタンが現れ、CSV＋描画データJSONを`.vtd`1ファイルに保存（`src/lib/vtd.ts`）。元がvtdバンドルだった場合のみ「上書き保存」でそのファイルへ直接書込み、素のCSVを開いた場合は常に新規ダウンロード。複数ファイル同時読込時は保存機能自体使えない。ズーム位置・トレード状態は保存対象外

### チャート表示・描画
- インジケーター: 200EMA（増分計算、デフォルトOFF）、SMA14（増分計算、デフォルトOFF）、ボリンジャーバンド（期間20、増分計算、デフォルトON）、一目均衡表の雲（先行スパンA/Bのみ、26本先行、デフォルトON）、区間区切り線（15m/1Hは日替わり・4Hは週替わり・1D/1Wは月替わり・MNは年替わり、デフォルトON）。全て4画面時のミニパネルにも連動（`src/lib/indicators.ts`・`src/lib/weekLines.ts`共有）。区切り線本体はDOMオーバーレイ（`weekOverlayRef`、zIndex:8、四角形のcanvas zIndex:9より下）
- 描画ツール起動: アイコンパネル（水平線・垂直線・ものさし・四角形・トレンドライン・ブラシ・テキスト、`src/components/DrawToolbar.tsx`）をワンクリックで有効化しチャート上のクリック/ドラッグで配置（配置後自動解除）。「連続描画」（鍵アイコン、`continuousDrawing`）ONで同じツールを解除せず連続配置可能。配置直後は必ず選択状態に入りパレットでその場編集できる。テキストのみ編集セッション継続のため次を置くには一旦クリックアウトしてから再クリックが必要。表示位置はチャート領域左の専用列（`App.tsx`）
- 水平線・垂直線のラベル表示ON/OFF（`showHLinePriceLabel`/`showVLineDateLabel`、`vt:lineLabels`保存）: 個別でなく全水平線/全垂直線一括の設定。垂直線ラベルは日付軸欄にDOM表示（`yy M/D hh:mm`形式）。デフォルト両方ON
- マグネット（`magnetMode`、デフォルトON）: 弱＝カーソルがOHLCの12px以内で吸着、強＝常に直下の足の最寄りOHLCへ吸着。ON/OFF自体は永続化せず毎起動ON、強さのみ`vt:magnetStrength`に保存。対象は水平線の配置/移動、四角形の描画/リサイズ（垂直線・ものさし・TP/SL編集は対象外）
- ジャンプモード（4画面専用、`isJumpSync`）: 描画ツールバー最下部の的アイコン。ONで足をクリックすると、クリックしたパネル以外の3枠だけその時刻へ移動。使用後は自動OFF。移動先は各パネル自身の`displayCandlesRef`に対する二分探索で算出
- パレットモード（`paletteMode`、デフォルトOFF）: 図形を選択すると自動ON、選択解除で自動OFF。選択中図形の色・線種・太さをその場で変更可能。変更値は対応する各種Draft（`lineDraft`等）にも同期し次の新規配置のデフォルトになる。図形未選択でもツール起動中（配置前）ならパレットを表示しDraftへ直接反映する
- 水平線・垂直線描画: クリック配置、ドラッグ移動。配置直後自動選択。選択中にDelete/Backspaceで削除、Cmd/Ctrl+C→Vで右下にずらして複製
- パレットの色順は`LINE_COLORS`（`types.ts`）で固定: 赤→オレンジ→黄→ティール→青→紫→グレー→白。四角形/トレンドライン/ブラシのデフォルト色は`LINE_COLORS[4]`（青）参照——並び順を変える時はこのインデックスも合わせて直すこと
- 四角形描画: ドラッグで対角に描画。色/線種/太さは共通パレット（`LINE_COLORS`8色）。4隅/4辺ドラッグでリサイズ、枠線ドラッグ（`findRectBorderNear`）で平行移動。平行移動は秒数でなく足インデックス差分で計算（週末の足抜け対策）。ヒット許容半径は`RECT_HANDLE_HIT_PX=12`。枠線本体は専用canvas（`rectCanvasRef`、トレンドライン等と同じDOMオーバーレイ方式）に自前描画（グリッド線・標準の価格ラインより上に出したいためSeries Primitivesは使わない——詳細は不変条件/地雷を参照）。**縦線（左右）のみ**、描いた直後にその時点の全ロウソク足（実体＋ヒゲ、高値〜安値をbarSpacing幅で）を`globalCompositeOperation:'destination-out'`で塗って重なった部分だけ透明に抜く（TradingView同様、ローソク足と重なった部分はローソク足が優先表示される）。**横線（上下）は透明抜きの対象外**——価格ラインとしての用途を優先し常に不透明のまま最前面に出す（縦線の透明抜き処理の後に描画することで実現）。選択中のリサイズハンドルのみ別レイヤーのDOM（`rectHandleOverlayRef`）
- トレンドライン描画: ドラッグで2点の線分。専用`<canvas>`（`trendCanvasRef`）に描画。端点ドラッグでリサイズ、本体ドラッグで平行移動（足インデックス基準）
- ブラシ描画（フリーハンド）: ドラッグ軌跡を点列（`DrawnBrush.points`）として記録、専用`<canvas>`（`brushCanvasRef`）に2次ベジェで平滑化描画。ピクセル距離基準（`BRUSH_MIN_PX=2px`）で間引いて記録。座標変換は足の内側でも連続値を返す`pixelToContinuousTime`を使用。描画直前にボックスフィルタ8パスで手ブレ補正。移動は素の時間差分（足インデックス基準ではない）
- テキストボックス描画: クリック配置と同時に編集モード。`contentEditable`直接編集（`window.prompt`不使用）、Enterは改行（`document.createTextNode('\n')`挿入）。空文字のまま確定/Escapeすると削除扱い。文字サイズ4段階（14/18/24/32px）・枠線スタイルはパレットで変更可
- Undo（Cmd/Ctrl+Z）: 全描画要素の追加・移動・リサイズ・削除・複製・スタイル変更を1手ずつ戻せる（`drawHistory`、最大50件）。Redoは未実装。CSV再読込でリセット
- 価格軸ドラッグへの追従: 縦スケール変更時、垂直線・四角形・トレンドライン・ブラシ・テキスト・雲の位置が追従（window mousemoveのフォールバック同期）
- ものさし: ドラッグで価格差・pips・%・本数・期間・中央線を計測。1回ドラッグで自動解除。ホイールクリック（中央ボタン）ドラッグでも計測可。符号・色はドラッグの始点→終点基準
- 価格軸の表示精度はペアの価格帯から自動判定（JPYクロス=小数3桁、それ以外=小数5桁）
- チャート全表示: `cursor`を最後の足まで進める（`advanceToEnd`、通過範囲の注文約定・TP/SL判定も一括処理）。末尾にいる間は発注パネル・速度スライダーを無効化
- 表示をリセット: 時間軸ズームを`resetTimeScale()`でデフォルトに戻し価格軸を`autoScale:true`に戻す。画面中心の足の位置は変えない
- 最新足に固定（`followLatest`）: 各パネルの縮尺を維持したまま最新足を右オフセット位置に表示し続ける。組み込み`scrollToRealTime()`は使わず`setVisibleLogicalRange`で自前計算。頭打ち基準はCSV全期間本数（`candles.length`/`nonMainCandles.length`）。メインパネルの最新本数基準は`Math.min(cursor, candles.length-1)`。1枠で手動パン/ズームするとそのパネルの`followAnchorRef`だけ更新され他パネルは影響を受けない。ボタン押下時は全パネルの`followAnchorRef`をリセット
- 日付ジャンプ（📅ボタン）: 日付のみ指定、常にその日00:00へジャンプ。縮尺維持で中心移動。過去日付は`cursor`を戻さず表示位置のみ移動、未来日付は`cursor`も進め通過範囲の約定判定を行う
- 画面キャプチャ: 「📷 キャプチャ」ボタンでチャート領域（`#vt-chart-capture-area`）をJPEGダウンロード（`src/lib/screenshot.ts`、`html-to-image`の`toJpeg`、`pixelRatio:1`/`quality:0.5`）。フローティング操作パネルは`EXCLUDED_IDS`で除外
- 全期間スクラバー: チャート下端の細いシークバー（メインパネルのみ）。つまみドラッグで平行移動、余白クリックでその位置へジャンプ。`setVisibleLogicalRange`を直接呼びstore/cursorには触れない
- 1画面/4画面レイアウト切替: 選択状態は`vt:chartLayout`に記憶。4画面時は枠位置固定（デフォルト左上15m・左下1H・右上4H・右下1D）、メイン枠のみ青枠で強調。4枠は常に同じ`CandleChart`をマウントし続けCSSで表示/非表示を切替（remountせずズーム/スクロール位置を保持）。パネルの実サイズが変わる際は`handleResize`がスケール（barSpacing）維持のまま表示本数を調整し中心の足を保つ。パネルヘッダーのドロップダウンで時間軸切替可能、切替時は直前の実時間範囲を保持（`pendingTimeframeSwitchRangeRef`）。パネル本体クリックでそのパネルをメインへ昇格（`promoteSlotToMain`、自前集計済みデータを再利用しDuckDB再クエリを省略）。非メインパネルは自分の足が完全に閉じてから表示（先出し防止）。各枠の時間軸組み合わせ・メイン枠位置・メイン時間軸は`vt:quad`に保存。描画の新規/選択/移動/削除・Delete/Undo/コピペは全パネルで動作するが、キーボードショートカットは直近マウス操作したパネル（`activePanelSlot`）にのみ効く
- TradingView風パネルヘッダー: 左上に「シンボル（ファイル名から検出）+時間足」表示
- ズーム/スケールの記憶: 時間軸ごとにパン・ズーム位置をlocalStorage保存、次回はどのデータを読み込んでも同じ拡大率で復元。パン位置は復元せず常に最新足に固定。保存済み本数（span）は実本数を超えないよう頭打ち（`relativeViewToLogicalRange`）。保存ビューが無い場合のフォールバック基準は`nonMainVisible`（実際にsetDataした本数）。保存ビューがある場合のクランプ基準は`nonMainCandles`/`candles`（CSV全期間本数）
- 4画面時の十字カーソル同期: いずれか1枠を実際にホバーすると他3枠にも同時刻の十字カーソルを表示（`chart.setCrosshairPosition`）。価格は各パネル自身の直前終値。ホバー先にその時刻が存在しない場合は非表示
- 十字カーソルは`CrosshairMode.Normal`（データ点への吸着なし、空白領域でも表示）

### 再生
- ▶（自動再生・1〜20倍速、`requestAnimationFrame`実装、速度はlocalStorageに記憶）/ ⏭（1コマ進む）/ ⏮（1コマ戻る、表示のみ・約定は取り消さない）
- フロート操作パネル: チャート上にドラッグで自由配置できる再生ボタン群。価格軸・時間軸の領域には重ならないようクランプ
- 再生中は右価格軸の`autoScale`を毎ステップ再有効化し縦方向のはみ出しを防止

### 発注・トレード
- 成行/指値/逆指値を選択して発注。指値・逆指値は現在値との上下関係を検証（不正な方向はエラー表示）
- TP/SLを発注時に設定可能。未約定の指値・逆指値にも約定前からTP/SLを表示・ドラッグ調整可能
- TP/SL・指値/逆指値の価格はチャート上で📍ボタンからクリック取得、またはドラッグで調整可能
- ロット指定: 固定ロット or リスク%モード（残高×リスク% ÷ |エントリー価格-SL| で自動計算、デフォルト3%）
- リスクリワード（R:R）プレビュー: draft中のエントリー・TP・SLから値幅を色付きボックスで可視化、比率を表示
- 発注パネルの「価格」「TP」「SL」（draft値）はいずれか1つでも入力済み・またはPickモード中なら「クリア」ボタンが現れまとめて空にできる
- 複数ポジション同時保有可能、個別決済/全決済
- エントリー・決済マーカー: チャート上に矢印（エントリー）と円（決済、損益付き）を表示。決済済みトレードは`closedTrades`に履歴保存
- 取引履歴パネル: エクイティカーブ（損益推移の線グラフ）+取引一覧テーブル（勝率・合計損益も表示）

### 口座
- 残高・含み損益（ポジション別・合計）のリアルタイム表示
- 初期残高は手動設定可能。クオート通貨がJPYなら100万、それ以外（USD等）なら1万がデフォルト（手動変更後は自動調整しない）
- リセットボタン: CSV再読込なしで残高・ポジション・履歴を初期化

## データモデル

```ts
Candle       { time: number(Unix秒,UTC), open, high, low, close: number }
Position     { id, side: 'BUY'|'SELL', openPrice, lots, openTime, tp?, sl?: number }
PendingOrder { id, side, type: 'limit'|'stop', price, lots, tp?, sl?: number }
ClosedTrade  { id, side, openPrice, closePrice, openTime, closeTime, lots, pnl: number }
DrawnLine    { id, price, color, dash: 'solid'|'dashed'|'dotted', width: 1|2|3|4 }
DrawnVLine   { id, time, color, dash, width }  // 構造はDrawnLineと同じでpriceがtimeに変わる
DrawnRect    { id, time1, price1, time2, price2, color, dash, width: 1|2|3|4 }  // 色・線種・太さは水平線・垂直線と共通のLINE_COLORS 8色パレット
DrawnTrendLine { id, time1, price1, time2, price2, color, dash, width }  // 構造はDrawnRectと同じ2点だが、対角の矩形ではなく2点を結ぶ線分として描画
DrawnBrush   { id, points: {time,price}[], color, width: 1|2|3|4 }  // ドラッグの軌跡そのままの点列。線種は無い（フリーハンドに馴染まないため）
DrawnText    { id, time, price, text, color, fontSize: 14|18|24|32, border: LineDash|'none' }  // アンカー1点＋自由文字列。線種・太さの代わりに文字サイズ4段階（デフォルト18px）・枠線（枠なし可）を持つ
LineSelection: { kind: 'h'|'v'|'rect'|'trend'|'brush'|'text', id: number } | null
TIMEFRAMES: [{sec:900,label:'15m'}, {sec:3600,label:'1H'}, {sec:14400,label:'4H'}, {sec:86400,label:'1D'}, {sec:604800,label:'1W'}, {sec:2629746,label:'MN'}]
// MNのsecは平均月長（秒）で近似値。DB集計は実際の暦月でdate_trunc、この値はcursorEnd等の「おおよその足の長さ」計算にのみ使う
```

DuckDB テーブル: `candles_1m`（ts: BIGINT, open/high/low/close: DOUBLE, volume: BIGINT）— 集計元の生データとして保持し続ける

## アーキテクチャ境界

- **プロセス境界**: シングルプロセス（ブラウザのみ）。バックエンドなし
- **DuckDB-wasm**: jsDelivr CDN からバンドル取得。App マウント時に先読み開始
- **状態管理**: Zustand store 1本（`useTraderStore`）+ セレクタ（`selectUnrealizedPnL`, `selectPositionPnL`）
- **永続化**: フォルダを開いた履歴のみ IndexedDB（`src/lib/openHistory.ts`）。他は全てメモリ
- **外部 API**: なし（File System Access API はブラウザ機能、外部通信ではない）

## 主要コンポーネント / モジュール責務

- `src/lib/duckdb.ts` — DuckDB初期化・複数CSV読み込み・任意時間軸集計クエリ（`queryCandles`はJST変換済みを返す。週/月足は`date_trunc`、それ以外は`floor(ts/sec)`）
- `src/lib/timezone.ts` — ブローカーサーバー時間（EU夏時間ルール GMT+2冬/+3夏）→JST変換
- `src/lib/currency.ts` — ファイル名から通貨ペア検出・クオート通貨/記号マッピング
- `src/lib/vtd.ts` — CSV＋描画データの1ファイル化（`splitVtdBundle`/`buildVtdBundle`）。区切り文字列より前は通常CSVのまま
- `src/lib/chartTheme.ts` — TradingView風チャート共通スタイル定数（フォント・軸文字色/サイズ）
- `src/lib/chartViewState.ts` — ズーム/スケールを時間軸ごとにlocalStorage保存/復元（絶対時刻でなく相対位置）
- `src/lib/indicators.ts` — EMA/SMA/BB/雲の全体再計算版（CandleChartは別途増分計算の最適化版を持つ）。雲のずらし先時刻`cloudDisplacedTime`のみCandleChart共通利用
- `src/lib/weekLines.ts` — 区間区切りの境界計算（`computeSeparatorBoundaries`、MN=年区切り、1D/1W=月区切り、4H=週区切り、15m/1H=日区切り）
- `src/lib/pips.ts` — 価格帯からpip単位・表示精度を推定
- `src/lib/crosshairSync.ts` — 4画面十字カーソル同期用（`priceAtTime`、範囲外はnull）
- `src/lib/openHistory.ts` — File System Access APIでフォルダを開いた履歴の保存/復元（IndexedDB）
- `src/lib/screenshot.ts` — チャート領域（`#vt-chart-capture-area`）をJPEG保存（`html-to-image`のラッパー）
- `src/store/useTraderStore.ts` — 全アプリ状態＋アクション。注文約定・TP/SL判定は`processOrderRange`（高安レンジ判定、SL優先）。チャート操作はシグナルパターン（`fitSignal`/`centerSignal`/`scrollToLatestSignal`をincrement→CandleChartのuseEffectが検知）
- `src/components/CandleChart.tsx` — lightweight-chartsラッパー。`{slot, isMain, timeframeSec}`propsを取る。**足データ取得経路がisMainで2分岐**: isMain=trueはグローバル`candles`/`cursor`を使い増分計算最適化、isMain=falseは`queryCandles`で自前集計（`nonMainCandles`）しメイン現在足の閉時刻までクリップ（`nonMainVisible`、先出し防止）し共有フル計算で毎回再計算。4画面でのremountなしのprops切替に対応するため`isMainRef`/`slotRef`/`mySourceIdRef`を軽量effectで同期し、初期化effect内は必ずこれらのrefを読む。全パネルでドラッグ/当たり判定・配置・テキスト編集・Delete/Undo/コピペが可能、ショートカットは`activePanelSlot`（直近mousedownしたパネル）にのみ効く。`clipboard`はモジュールスコープで全インスタンス共有。メイン昇格直後は最新足への強制ジャンプを1回スキップ（`wasMainForDataSyncRef`）、降格直後は非メイン同期の初回フィットを1回スキップ（`skipNextNonMainFitRef`）
- `src/components/MiniChart.tsx` — 現在未使用（`App.tsx`から参照削除済み、ロールバック用に残存）。全パネルが`CandleChart`に統一されたため退役
- `src/components/ChartHeader.tsx` — パネル左上の「シンボル+時間軸」表示＋全画面切替ボタン。時間軸ラベルクリックでドロップダウン開閉。全画面ボタンは非メイン枠なら`promoteSlotToMain`後に1画面化
- `src/components/Controls.tsx` — 時間軸/表示モード/発注パネル/ポジション・注文一覧/口座情報。発注パネル等は`MenuButton`ポップアップに集約
- `src/components/FloatingControls.tsx` — ドラッグ移動可能な再生ボタン群（チャート領域内にクランプ）
- `src/components/DrawToolbar.tsx` — 描画ツール起動アイコンパネル。クリックで`isDrawingLine`等のstore状態をトグルするのみ、実際の配置/描画は`CandleChart`側が担う。最下部の目アイコンで`overlaysHidden`を一括トグル（EMA/SMA/BB/雲は色を透明化しオートスケールジャンプを回避、描画物はvisibility切替）
- `src/components/PalettePanel.tsx` — パレットモードON時のみ表示するドラッグ移動可能なスタイル選択ウィンドウ。図形との同期は`store`の`syncPaletteStyleFrom`/`applyPaletteStyleTo`が担う
- `src/components/HistoryPanel.tsx` — エクイティカーブ＋取引履歴テーブル（オーバーレイパネル）
- `src/components/FileLoader.tsx` — 「ファイル選択▾」ドロップダウン（開く履歴）＋「💾 vtd保存」ボタン
- `src/components/ErrorBoundary.tsx` — レンダー/エフェクト中の例外を捕捉し黒画面の代わりにエラー内容を表示（`main.tsx`でApp全体を包む）
- `src/lib/errorLog.ts` — 例外をlocalStorage（`vt:errorLog`、直近20件）に記録。`window.onerror`/`unhandledrejection`とErrorBoundary両方から書き込む

## 不変条件 / 地雷

- DOMオーバーレイ（雲・トレンドライン・ブラシ・垂直線・テキスト・四角形・週区切り線等）は`right: chartRightMargin`pxで価格軸を、`chartBottomMargin`で日付軸欄を避けること（`inset:0`等で全面に広げない）
- lightweight-charts標準の最終値価格ライン（`priceLineVisible`のデフォルト、水平の破線＋現在値ラベル）とグリッド線（`layout.grid`）はSeries Primitivesの対象外でzOrder制御ができず、常に他の描画物より前面に出る。四角形・週区切り線がPrimitivesではなくDOM/canvasオーバーレイなのはこの制約を回避するため（詳細は主要機能の四角形描画の項）
- `showFullHistory`は廃止済み。全期間スクラバーの「全体」は常に`cursor+1`、`candles.length`（未来含む全データ）は使わない
- `setVisibleLogicalRange`へ渡す`from`/`to`は`LogicalRange`型変数に一度代入すると型エラーになる。その場のオブジェクトリテラルで直接渡すこと
- `resetTimeScale()`直後に`getVisibleLogicalRange()`を読んでも古い値が返る（非同期）。`requestAnimationFrame`を挟んでから読むこと
- 自前`<canvas>`（雲・トレンドライン・ブラシ）は`devicePixelRatio`倍で実解像度を確保し`ctx.setTransform`で描画すること（Retinaでのぼやけ・カクつき防止）
- BBは`showBB`OFF中も裏で計算継続し`visible:false`で隠すだけ（再計算漏れ防止）
- `rawCsvText`は単一ファイル読込時のみセット（複数ファイルは大容量CSV二重読みを避けるため非対応）
- DuckDB-wasmはSharedArrayBuffer使用のためVite dev serverに`COOP/COEP`ヘッダ必須（`vite.config.ts`設定済み）
- `read_csv`に`all_varchar=true`/`ignore_errors=true`必須
- P&L計算はクオート通貨そのまま（円換算しない）
- JST変換は`queryCandles`の集計結果に事後適用（生の1分足には適用しない）。バケット境界自体はブローカー時間基準のまま残るため、カレンダー時刻を直接使う機能は実在の足と一致しない。区切り線は実際の足を境界に使う方式（`computeSeparatorBoundaries`）を踏襲すること
- チャートの時間軸目盛りは全シリーズ時刻の和集合。一目雲のずらしは秒数でなく**本数**で行うこと（`cloudDisplacedTime`）。図形の平行移動も秒数でなく足インデックス（`candleIndexAt`）で行うこと（週末の足抜け対策）
- `timeToCoordinate`/`priceToCoordinate`は`setData`/`setVisibleRange`/`applyOptions`直後は古い座標を返すことがある。同処理の最後に`requestAnimationFrame`で再同期すること
- 月境界マークは`tickMarkFormatter`を通らず`localization.dateFormat`を使う。有効トークンは`yyyy/yy/MMMM/MMM/MM/dd`のみ
- 非メインの`nonMainVisible`再描画は`length===0`で早期returnしないこと（空でも`setData([])`を呼び画面を空にする）
- 自動再生は`requestAnimationFrame`（`setInterval`は高速再生時に描画ノイズが出る）
- ドラッグ系操作は開始時に`handleScroll`/`handleScale`を無効化し終了時に必ず再有効化すること
- 水平線・垂直線・TP/SL・draft価格は丸めない（表示側のみ`toFixed`）
- `onMouseDown`ヒット判定順序は「四角形→トレンドライン→ブラシ→テキスト→水平線」（水平線は全幅ヒットするため最後）
- DOMオーバーレイのz-indexは10〜13、雲の`<canvas>`はz-index:5
- ローソク足・背景・グリッドはlightweight-charts内部で同じ1枚のcanvasに一括描画される。DOM要素の負のz-indexで「ローソク足の下」に見せようとすると背景ごと隠れて何も見えなくなる（試すだけ無駄）
- 雲の塗りつぶしは`candles[0].time`より左側には描画しないようガードすること（範囲外の外挿防止）
- `jumpToTime`は過去日付ジャンプで`cursor`を戻さないこと（`Math.max(idx, oldCursor)`）
- `centerOnTime`は時刻ベースでなく足インデックス（logical range）で計算すること（`getVisibleRange`/`setVisibleRange`は表示幅が狭い時に破綻する）
- `setVisibleRange()`（時刻ベース）は内部のtime→logical変換に失敗してクラッシュすることがある。全期間表示は`{from:0, to:candles.length}`のindexベースで直接指定すること
- `processOrderRange`は1本ずつ順に処理、同一バーでTP/SL両方ヒット時はSL優先。`jumpToTime()`は前進時のみ通過範囲を判定（後退は判定しない）
- `centerSignal`等のeffectはリプレイモードのcursor effectより後に置くこと（先に置くと`scrollToRealTime()`に上書きされる）
- CSV再読込で`lines`/`vlines`/`rects`/`closedTrades`/`positions`/`pendingOrders`は全リセット。時間軸切替では保持
- フォルダを開いた履歴はChrome/Edgeのみ対応（File System Access API）。Safari/Firefoxはフォールバックし履歴機能自体出ない
- 履歴の`FileSystemDirectoryHandle`は`startIn`の起点としてのみ使う（中身は読まない）。フルパスは取得不可能な仕様のため表示名はフォルダ名止まり
- フロートパネルの位置クランプは`chart.priceScale('right').width()`/`chart.timeScale().height()`の実測値をstore経由で共有
- `setTimeframe`のカーソル復元は新しい足の**終了時刻**で比較すること（`newCandles[i].time + sec <= currentClose`、開始時刻だけだと先出しになる）
- `FloatingControls`は`offsetParent`基準でクランプ
- `CandleChart`のルート`<div>`は`width/height:100%`を明示すること（CSS grid内のラッパー経由のため自動では伸びない）
- `CandleChart`の`priceLineMapRef`等のIPriceLineマップは、チャート初期化effectのクリーンアップで必ず`.clear()`すること（`chart.remove()`だけだと古い参照が残りクラッシュする）
- `quadTimeframes`/`quadMainSlot`と起動時のメイン時間軸（`timeframeSec`）は同じ`vt:quad`に保存されている（別々に持たない）
- `ChartHeader`のクリック可能領域はlightweight-charts内部canvasと同じz-index帯（z-index:2）を避けること
- 十字カーソル同期は`param.sourceEvent`の有無で実マウス操作か同期再発火かを判定（無限ループ防止）。マウスが画面外に抜けた時は`onMouseLeave`で明示クリア
- `chart.setCrosshairPosition`は範囲外の時刻を渡しても無言でスナップする。`priceAtTime`がnullを返す場合は呼ばず`clearCrosshairPosition`すること
- lightweight-chartsのchart/series APIを呼ぶeffectは全てtry/catchで包み`errorLog.ts`に記録して処理継続すること（パネル高速切替でクラッシュすることがある）
- 同エラーがtry/catchのスコープ外（`window.onerror`）に漏れることがあるが、その場合ErrorBoundaryは発火せずアプリは壊れず動作継続する
- Vite dev serverは`preview_start`の既存プロセス使い回しで編集が反映されないことがある。挙動がおかしい時は`preview_stop`→`preview_start`で再起動すること
- 四角形の`pixelToTime`は`coordinateToTime`ベース（範囲外のみクランプ）。ブラシのような連続サンプリングには`pixelToContinuousTime`を使うこと（`coordinateToTime`は足の内側でスナップするため階段状になる）
- 描画済み図形の表示（`timeToCoordinate`）は時刻が実在の足と完全一致しないとnullを返す。`timeToX`ヘルパーで線形補間して回避している（vlines/rectsの描画・当たり判定は全てこれ経由にすること）
- Delete/Backspaceでの削除は両キーを拾うこと（Macの物理削除キーは通常Backspace）

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
- セッション永続化なし（リロードで CSV 再読み込みが必要。開いた履歴からのワンクリック再読み込みはできない。ダイアログの初期位置が復元されるだけ）
- 高速再生（20x）時にヒゲ部分のちらつきが残る場合がある（実害小、保留中）
- 非JPYクオートペアの損益は実際の円換算をしていない（クオート通貨のまま表示）
