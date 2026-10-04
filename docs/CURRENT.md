# CURRENT

> 「今どうなっているか」だけを書く。経緯は CHANGELOG / git log。判断理由は ADR。
> このファイルは**上書き更新**。"Phase NN" のような時系列ラベルを書かない。

---

## 技術スタック

- **Runtime**: ブラウザのみ（Vite 5 dev server）。React 18 + TypeScript 5、Vite 5 + @vitejs/plugin-react
- **チャート**: lightweight-charts 4 / **データ処理**: @duckdb/duckdb-wasm 1.29 / **状態管理**: Zustand 4
- **永続化**: CSV・取引状態は無し（リロードで消える）。開いた履歴・エラーログのファイルハンドルは IndexedDB、表示設定類は localStorage（`vt:*`）
- **デフォルト**: 初回は4画面・メイン15m（以降はレイアウトとメイン時間軸を記憶）。BB・雲・区切り線・セッション帯ON、EMA200/SMA14はOFF

## 主要機能

### データ読み込み・保存
- Axiory MT4形式 1分足CSV（複数可、ファイル名昇順で結合）。D&D読込（`App.tsx`の`loadFiles`、履歴には残らない）
- 開いた履歴（Chrome/Edgeのみ、最大12件、`openHistory.ts`）。「ファイル選択▾」から選択、行の×で個別削除（`removeFromHistory`）
- 1分足→5m/15m/1H/4H/1D/1W/MNへDuckDBで集計。表示はJST（CSVはEU夏時間ルールGMT+2/+3前提で変換）
- 通貨記号はファイル名から検出（円換算はしない）。価格精度はJPYクロス3桁・他5桁
- `.vtd`保存（単一ファイル読込時のみ）: CSV＋描画全8種＋`closedTrades`＋`cursorTime`を1ファイル化。vtdを開いた時だけ「上書き保存」、上書き1回成功で10分ごとの差分自動保存が武装（`autoSaveArmed`/`autoSaveTick`、新規読込で解除）
- vtd対象外: 建玉・未約定注文・残高設定（残高は初期残高＋復元取引の損益で再計算）、ズーム位置。読込時は`findCursorForTime`で現在の時間軸へcursorを復元

### チャート表示
- 1画面/3画面/4画面。4画面は2x2（既定15m/1H/4H/1D）、3画面は大枠+2枠（既定15m/1H/4H、配置`left`/`top`は3画面ボタンを3画面中にもう一度押して切替）。3画面と4画面の時間軸・メイン枠は別管理。枠間の`gap`（2px）に背景色`#3a3a3a`を敷いて境界を1本の線として見せる（`App.tsx`）
- パネルクリックでメイン昇格（`promoteSlotToMain`）。昇格しても「今」の時刻は変わらず、戻せば元通り。メインは青枠
- パネルヘッダー: シンボル+時間足（ドロップダウンで切替、前回ズーム復元）、🏷トレードマーカー表示切替（時間足単位）、全画面、「この時間足のみ表示」（表示中の描画種類のうち、まだ限定されていないものは「この時間足限定」に、他の時間足で制限されているものは「全時間足表示」に戻す。種類は1項目にまとめる）、ATR(14)バッジ（pips）、現在時刻「YYYY/MM/DD(曜) HH:mm」
- インジケーター: EMA200・SMA14・BB(20)・一目雲（先行スパンA/Bのみ）・区間区切り線（5m〜1H=日、4H=週、1D/1W=月、MN=年）・東京/ロンドン/NYセッション帯（JST 9-16/16-22/22-7、日足以上は非表示）。全パネル連動
- 目アイコン（`overlaysHidden`）でインジ・描画物を一括非表示
- 3/4画面で十字カーソル同期（各パネル自身の足の時刻・直前終値）。十字は`CrosshairMode.Normal`
- 全期間スクラバー（メインのみ）、📅日付ジャンプ（「移動」/「巻き戻し」。年/月/日は別欄のテキスト入力で全角→半角自動、年は空欄可＝リプレイ中の足の年、実行後は欄を空にしてポップアップを閉じる。解釈は`lib/jumpDate.ts`）、表示リセット、最新足に固定（`followLatest`）、📷キャプチャ（`#vt-chart-capture-area`をWebP保存、R:R画像と同じ生成処理）
- ジャンプモード（3/4画面、`isJumpSync`）: 足をクリックすると他パネルがその時刻へ移動、使用後自動OFF。垂直線の右クリックでもその線の時刻へ同じジャンプ同期
- チャート本体（プロット領域）をつかんでパンしている間はカーソルを`grabbing`（つかんだ手）にする（`CandleChart.tsx`の`panGrabbing`、価格軸・日付軸のスケール操作は対象外）
- ズームは時間軸ごとにlocalStorage記憶（`vt:chartView:<sec>`）。パン位置は復元せず最新足基準

### 描画
- ツール: 水平線・垂直線・ものさし・四角形・トレンドライン・平行チャネル・矢印・ブラシ・テキスト（`DrawToolbar.tsx`）。配置後は自動解除し選択状態へ。鍵アイコン（`continuousDrawing`）で連続配置
- パレット（`paletteMode`）: 選択中の図形の色（`LINE_COLORS`8色）・線種・太さ・表示時間足（`hiddenTimeframes`、1H/4H/1D/1W/MN個別、1H OFFで5m/15mも非表示）を変更。変更値は次回配置の既定にもなり、種類ごと（水平線=垂直線は共有、他は個別）に`vt:drawDrafts`へ記憶して次回起動に引き継ぐ
- マグネット（`magnetMode`、毎起動ON、強さのみ`vt:magnetStrength`）: 水平線配置/移動、四角形・2点図形の描画/リサイズに効く
- 水平線/垂直線ラベルのON/OFFは全線一括（`vt:lineLabels`）
- 四角形は枠線でのみ選択（内側クリックは無反応）、4隅/4辺でリサイズ。2点図形は端点リサイズ・本体移動
- 平行チャネル: ドラッグで基準線→1クリックでオフセット（価格差）確定。基準線/オフセット線どちらを掴んだかで編集が変わる（`LineSelection.part`）。基準線の新規描画・端点ドラッグ中Shiftで水平に拘束。オフセット線の上下ドラッグも新規確定と同じくマグネット吸着（吸着価格−基準線のその時刻の価格）
- 矢印: 最前面・最優先で掴める。Shiftで水平/垂直に拘束
- ブラシ: 平滑化0〜24パス（既定`DEFAULT_BRUSH_SMOOTHING`=12、移動平均）。閉じたストロークは三角形/円に自動認識（`shapeRecognition.ts`）し、頂点/外接矩形の角で再編集可
- テキスト: クリック配置で即`contentEditable`編集。Enterは改行、IME確定のEnterは確定のみ。空のまま確定で削除。文字サイズ14/18/24/32・枠線。空の間は「文字を入力」プレースホルダー
- 選択中: Delete/Backspaceで削除、Cmd/Ctrl+C→Vで複製。Cmd/Ctrl+ZでUndo（`drawHistory`最大50、Redo無し、CSV再読込でリセット）
- ものさし: ドラッグまたはホイールクリックドラッグで価格差・pips・%・本数・期間を計測

### 再生
- ▶自動再生（1〜20倍、速度記憶。フレームが間に合わない時は経過時間ぶん最大30本まとめて`advance(steps)`し速度を保つ。メイン/非メインとも複数本を差分更新）/⏭1コマ進む/⏮1コマ戻る（表示のみ、約定は取り消さない）。ボタンは下部`Controls.tsx`
- キーボード: ←1コマ戻る／→・スペース1コマ進む／↑再生・一時停止（`App.tsx`でグローバルに1箇所だけ拾う。テキスト入力中は無効）
- チャート全表示（`advanceToEnd`、通過範囲の約定判定込み）。末尾では発注パネル・速度スライダー無効

### 発注・トレード
- 成行/指値/逆指値、TP/SL（方向矛盾は発注時に弾く）。発注パネル（`OrderPanel.tsx`）はBUY/SELL選択→「注文執行」の2段階
- ロット: 固定 or リスク%（既定3%）。R:Rプレビュー、📍クリック取得/ドラッグで価格調整、「クリア」で価格/TP/SL一括消去して発注パネルも閉じる
- 複数ポジション、個別/全決済。建玉のエントリー価格ライン、TP/SLラインにpips表示
- トレードマーカー: 下部専用行の「#N」タグ（採番は取引履歴の#と同じcloseTime昇順）。クリックで取引履歴の該当行へ、右クリックでトレード日誌メモ窓を開く
- 取引履歴パネル: エクイティカーブ・指標・方向別/セッション別/曜日別/保有期間帯別分析・取引一覧（行クリックでエントリー時点へ移動）。MAE/MFE・決済後12h/24hの値動き（`tradeExcursion.ts`）
- トレード日誌: 取引一覧の行頭アイコン／チャートの#Nタグ右クリックでメモ窓（`TradeMemoWindow.tsx`、`fixed`・z110）。自由テキスト（`ClosedTrade.memo`、.vtd保存）。ヘッダーのドラッグで移動・右下でリサイズ、位置は`vt:tradeMemoWin`。保存はblur/閉じる/別取引切替時（打鍵ごとだと集計が再計算される）。ヘッダーはpips・保有期間、「テンプレ」で表示中パネルの時間足見出し（■1D等）を挿入。AIエクスポートには未反映
- R:R画像: TP/SL付きで発注すると、その時のチャート領域を`rrImage`としてPosition/PendingOrder/ClosedTradeへ引き継ぐ（.vtd保存）。メモ窓上部の「📎 発注時のR:R画像（NNKB）」クリックで拡大。生成は`lib/screenshot.ts`: `captureChartAreaCanvas`（canvasを直接重ね、DOMだけhtml-to-image）→`encodeCanvasFitted`（WebP・100KB以内に品質を二分探索）。符号化は発注後に裏で行い`attachRrImage`で付与
- 「📊 AI分析用エクスポート」（`aiExport.ts`）: 前提説明＋指標＋全取引をMarkdownで書き出し
- 曜日別・保有期間帯別は試験的指標（`HOLD_BUCKETS`/`WEEKDAY_LABELS`、不要なら削除）

### 口座
- 残高・含み損益表示。初期残高はJPYクオート100万・他1万が既定（手動変更可）。リセットでCSV再読込なしに初期化

## データモデル

```ts
Candle       { time(Unix秒,UTC), open, high, low, close }
Position     { id, side:'BUY'|'SELL', openPrice, lots, openTime, tp?, sl?, rrImage? }
PendingOrder { id, side, type:'limit'|'stop', price, lots, tp?, sl?, rrImage? }
ClosedTrade  { id, side, openPrice, closePrice, openTime, closeTime, lots, pnl, tp?, sl?, memo?, rrImage? }  // tp/slは旧データに無い。memo=トレード日誌、rrImage=発注時R:R画像(data URL)。どちらもvtdに保存
DrawnLine    { id, price, color, dash:LineDash, width:1|2|3|4 }
DrawnVLine   { id, time, color, dash, width }
DrawnRect / DrawnTrendLine / DrawnArrow { id, time1, price1, time2, price2, color, dash, width }
DrawnChannel { ...2点, offset(価格差), color, dash, width }
DrawnBrush   { id, points:{time,price}[], color, width, smoothing?, shape?:'triangle'|'circle' }
DrawnText    { id, time, price, text, color, fontSize:14|18|24|32, border:LineDash|'none' }
// 描画8種はすべて hiddenTimeframes?: TimeframeSec[] を持つ
LineSelection { kind:'h'|'v'|'rect'|'trend'|'channel'|'arrow'|'brush'|'text', id, part?:'base'|'offset' } | null
TIMEFRAMES   5m=300 15m=900 1H=3600 4H=14400 1D=86400 1W=604800 MN=2629746
// MNのsecは平均月長の近似。DB集計は暦月date_trunc、この値は「おおよその足の長さ」計算用
```

DuckDB: `candles_1m`（ts BIGINT, open/high/low/close DOUBLE, volume BIGINT）を集計元として保持

## アーキテクチャ境界

- バックエンドなし。DuckDB-wasmはjsDelivr CDNから取得、Appマウント時に先読み
- Zustand store 1本（`useTraderStore`）+ セレクタ（`selectUnrealizedPnL`/`selectPositionPnL`）
- 外部通信なし（File System Access APIはブラウザ機能）

## 主要コンポーネント / モジュール責務

- `lib/duckdb.ts` — DuckDB初期化・CSV読込（`loadCSVFiles`）・集計（`queryCandles`、JST変換済み。週/月足は`date_trunc`、他は`floor(ts/sec)`）
- `lib/timezone.ts` / `currency.ts` / `pips.ts` — ブローカー時間→JST、通貨ペア検出、pip単位推定
- `lib/vtd.ts` — `splitVtdBundle`/`buildVtdBundle`。区切りより前は素のCSV、取引履歴の無い旧形式は空配列で読める
- `lib/chartViewState.ts` — ズームを時間軸ごとに相対位置で保存/復元（`relativeViewToLogicalRange`）
- `lib/indicators.ts` — EMA/SMA/BB/雲/ATRのフル計算と末尾だけの`computeTail`（非メインが使用）、`cloudDisplacedTime`
- `lib/weekLines.ts`（`computeSeparatorBoundaries`/`computeDayBoundaries`）、`lib/sessions.ts`（`computeSessionBands`、取引分析用`sessionKeyAt`）
- `lib/partialCandle.ts` — `buildPartialCandle`/`findBucketIndexContaining`（形成中足の部分集計、非メイン描画とメイン切替で共有）
- `lib/orderMatching.ts` — `processOrderRange`（指値の約定・TP/SL判定。同一足でTP/SL両方ならSL優先、ADR 002）/`lib/jumpDate.ts` — 日付移動の入力解釈。どちらもテストあり
- `lib/tradeFormat.ts` — `fmtDuration`（保有期間の表示）/`tradePips`（符号付き獲得pips）。取引履歴とメモ窓ヘッダーで共用
- `lib/crosshairSync.ts` — `priceAtTime`（範囲外null、戻り値`time`は自パネルの足の時刻）
- `lib/tradeStats.ts`（`computeTradeStats`・`plannedRR`）、`tradeExcursion.ts`、`aiExport.ts`、`screenshot.ts`（チャート領域の画像化。`EXCLUDED_IDS`で操作パネル除外）、`orderPanelPos.ts`（`vt:orderPanelPos`）
- `lib/errorLog.ts` — 例外を`vt:errorLog`（直近20件）へ。`window.onerror`/`unhandledrejection`/ErrorBoundaryから記録
- `lib/errorLogFile.ts` — ログの実ファイル追記（Chrome/Edge、DB`virtual-trader-errorlog`、2MB超で後半のみ残す）。UIは「🪲 ログ」メニュー
- `store/useTraderStore.ts` — 全状態＋アクション。チャート操作はシグナル（`fitSignal`/`centerSignal`/`scrollToLatestSignal`をincrement→effectが検知）。パレット同期は`syncPaletteStyleFrom`/`applyPaletteStyleTo`
- `components/CandleChart.tsx` — lightweight-chartsラッパー（props`{slot, isMain, timeframeSec}`）。isMain=trueはグローバル`candles`/`cursor`、falseは`queryCandles`で自前集計（`nonMainCandles`→`nonMainVisible`、末尾に形成中足）。remountせずprops切替なので、初期化effect内は`isMainRef`/`slotRef`/`mySourceIdRef`を読む。初期化effectが`createSyncXxx`で描画モジュールを組み立て、プレビュー状態は`let`で持ちgetter/setterで渡す
- `components/chart/` — CandleChartから切り出したモジュール（読むだけのrefは`refs.ts`の`ReadRef<T>`）
  - 描画: `linesOverlay`・`rectsOverlay`・`trendLinesOverlay`（`drawTrendLineShape`）・`channelsOverlay`・`arrowsOverlay`・`brushesOverlay`・`textsOverlay`・`cloudOverlay`・`rrPreviewOverlay`・`measureOverlay`・`weekLinesOverlay`・`sessionsOverlay`・`tradeMarkersOverlay`・`scrubber`（`{sync, dispose}`）
  - マウス: `drag`（`DragSession`/`EditTool`/`combineTools`/`lockChartForDrag`）。ツール: `vlineTool`/`twoPointTool`（トレンド・矢印）/`channelTool`/`rectTool`/`brushTool`/`priceLineTool`/`textMoveTool`/`measureTool`
  - 部品: `hitTest`（`findXxxNear`）、`coordinates`（`pixelToTime`/`pixelToContinuousTime`/`magnetSnap`）、`candleIndex`、`canvas`（`DASH_TO_CANVAS`/`beginCanvasFrame`）、`keyboard`、`textEditing`
  - フック: `useIndicatorSeries`（メインの増分計算）、`useViewRange`（`useViewRangeCommands`=リサイズ/リセット/最新足、`useViewRangeSync`=追従/十字同期/時間足切替/日付・ジャンプ同期）、`usePriceLines`
- `components/ChartHeader.tsx` / `Controls.tsx`（下部バー・`MenuButton`ポップアップ・再生ボタン）/ `OrderPanel.tsx` / `PalettePanel.tsx`（位置はマウント中のみ記憶）/ `DrawToolbar.tsx`（ツール起動と`DrawnObjectsPopup`一覧）/ `HistoryPanel.tsx` / `FileLoader.tsx` / `ErrorBoundary.tsx`（`main.tsx`でApp全体を包む）
- `OrderPanel`: 開いた時・注文種別/方向切替時に`lastOrderRatiosByKey`（`${orderType}:${side}`）の前回比率を価格/TP/SLへ仮入力

## 不変条件 / 地雷

**描画オーバーレイ**
- オーバーレイは`right: chartRightMargin`で価格軸、`chartBottomMargin`で日付軸欄を避ける（`inset:0`禁止）。四角形は`clampBottom`、斜線系はcanvas`clip`
- z順: 雲canvas 5 < 区切り線/セッション/マーカー 8 < 描画canvas 9 < 矢印 10 < `overlayRef` 11 < ものさし 12 < RR 13 < スクラバー 14
- グリッド・最終値ラインはSeries Primitivesで前後制御できない。描画物はPrimitivesでなく自前canvas/DOMで描く
- ローソク足・背景・グリッドは同一canvas。負のz-indexで「足の下」に置くと背景ごと隠れる
- 描画物と重なる足を抜くのは`cutCandlesFromCanvas`（`CandleChart.tsx`、ヒゲ幅`WICK_CUTOUT_PX`は近似）に一本化。対象は開示済み足（`effectiveCursorRef`まで）のみ。`displayCandlesRef`はメインだと未来足を含む
- ロウソク足Series（`addCandlestickSeries`）はEMA/SMA/BB/雲の線Seriesより後に追加する（後から追加したものが上）
- 自前canvasは`devicePixelRatio`倍で確保し`setTransform`で描く
- 価格軸スケール変更は購読できない。再描画は`syncDrawingOverlays`に一本化し全経路から呼ぶ。新しい描画要素はここへ足す
- 描画・当たり判定・ハンドルは`getVisibleDrawings()`経由（生配列だと非表示図形が反応）。例外: 水平線の価格ラベル同期、ドラッグ中のID引き、テキスト
- 描画種を増やす時は`pushDrawHistory`/`undo`/`DrawSnapshot`/`loadFiles`/`saveChartFile`/`vtd.ts`の6箇所に配列とnextIdを追加
- 巨大effectで`syncXxx`が参照する`let`は`syncXxx`定義より前に置く（TDZ）。共有定数はモジュールレベル（`chart/canvas.ts`）
- 既存図形を掴む判定順は`editTools`の並び1か所（mousedownとホバー共通）。矢印は先頭寄り、水平線は全幅ヒットのため最後
- 2点図形の当たり判定は`projectSegment`/`hitSegmentEndpoint`/`hitSegmentBody`を使う
- ドラッグ中は`lockChartForDrag`で`handleScroll`/`handleScale`を切り、終了時に必ず戻す
- 水平線・垂直線・TP/SL・draft価格は丸めない（表示のみ`toFixed`）
- 水平線本体はcanvas描画、`createPriceLine`は`lineVisible:false`で価格軸ラベル専用
- `DrawToolbar`のポップアップは祖先`overflow:hidden`で切れるため`position:fixed`＋`getBoundingClientRect`

**座標変換**
- `timeToCoordinate`は実在・setData済みの足と完全一致しないとnull（雲の先行範囲と画面外は例外）。図形は`timeToX`（線形補間）経由
- 垂直線・トレードマーカーは、描画・ハンドル・当たり判定（`findVLineNear`）すべて`timeToXSnapped`（含む足へスナップ）。1箇所だけ変えるとズレる
- 開示済み最後の足より先（未来）の時刻は、`timeToX`が全期間の足の並び上の位置を`logicalToCoordinate`の整数2点補間で外挿する（最後の足へのクランプは角度が変わる。小数indexを渡すと0が返る）
- `pixelToTime`は`coordinateToTime`ベース。ブラシ等の連続サンプリングは`pixelToContinuousTime`
- 平行移動・雲のずらしは秒でなく足インデックス（`candleIndexAt`/`cloudDisplacedTime`）。ブラシ移動のみ素の時間差
- cursorより未来の時刻（セッション終了等）は開示済み最後の足の終わり（`time + timeframeSec`）へクランプしてから`timeToX`
- 座標APIは`setData`/`setVisibleRange`/`applyOptions`直後に古い値を返す。最後に`requestAnimationFrame`で再同期
- 雲の塗りは`candles[0].time`より左に描かない

**表示範囲・追従**
- `setVisibleLogicalRange`の引数はその場のオブジェクトリテラルで渡す（`LogicalRange`変数経由は型エラー）
- `setVisibleRange`（時刻ベース）はクラッシュし得る。index指定の`setVisibleLogicalRange`を使う。`centerOnTime`も足インデックスで計算
- `resetTimeScale()`直後の`getVisibleLogicalRange()`は古い。rAFを挟む
- 最新足固定は`scrollToRealTime()`でなく`applyLatestViewRef`。`fullTotal + offset`が0以下なら既定オフセットへフォールバック
- `followAnchorRef`は`followLatest`がfalseになってもnullに戻さない（非nullなら戻る操作でも`applyLatestViewRef`で位置確定）
- 非メインは`followLatest`に関わらず常時追従。ジャンプ同期後（発信元含む）・`centerSignal`移動後は`captureFollowAnchorRef`でアンカーを捕捉。降格の瞬間は`effectiveCursorRef`上書き前の値で直接アンカーを作る。アンカー未設定の非メインは`nonMainVisible`更新のたび最新足へ寄る
- 追従・十字同期・`centerSignal`等は`useViewRangeSync`内。必ずsetData系effectより後で呼ぶ（先だと空範囲でアンカー捕捉）
- メイン昇格直後の最新足強制ジャンプは1回スキップ（`wasMainForDataSyncRef`）、降格直後の非メイン初回フィットも1回スキップ（`skipNextNonMainFitRef`、空の`nonMainCandles`では消費しない）
- 保存ビュー復元は`to`固定・`from`を0未満にしない（リプレイ序盤のはみ出し防止）。spanは全期間本数で頭打ち
- 全期間スクラバーの全体は`cursor+1`（`candles.length`は未来を含むので使わない）

**メイン/非メインと時間足切替**
- 非メインの形成中足は`nonMainCursorEnd`（=`mainRevealedUntil`）基準で探す。`candles[cursor].time`基準や再計算は先出し・asc順エラーの原因
- 形成中足の元データは`finestSourceCandles`/`finestSourceCursor`（`setTimeframe`で更新しない）。グローバル`candles`は使わない
- バケット開始時刻は自前計算せず`nonMainCandles`から引く（ブローカー時間境界とJSTのズレ）
- `setTimeframe`のcursor復元は`mainRevealedUntil`基準、未確定なら`buildPartialCandle`の形成中足に置く
- ヘッダーの現在時刻表示は`mainDisplayTime`（切替をまたいで据え置き）を表示
- 非メインの`nonMainVisible`は空でも`setData([])`する（`length===0`で早期return禁止）
- 非メインは、確定足が前回と同じ（先頭・末尾直前が同一参照、増分400本以内、200本以上）なら`computeTail`で末尾だけ`update()`、それ以外は全体`setData`（`nonMainPrevRef`、メイン中は破棄）
- 全期間を走査するオーバーレイ（`cutCandlesFromCanvas`/雲/セッション帯/区切り線）は表示範囲（`getVisibleLogicalRange`）だけ処理。区切り線・セッション帯の元データは非メインでは`nonMainCandles`
- lightweight-charts 4.2.3はデータ更新のたび系列の全点を再構築する（描画コストは系列本数×総本数）。長期間の細かい時間足パネルが再生の重さの主因
- 起動時メイン時間軸は`vt:quad3`/`vt:quad4`の`timeframes[mainSlot]`から決まる（別に保存しない）
- 1画面時の非メイン3枠・3画面時の枠3は`width/height:0`でマウントし続ける（remount回避）
- chart/series APIを呼ぶeffectはtry/catch＋`errorLog`で継続（`window.onerror`に漏れても動作継続）

**十字カーソル同期**
- `setCrosshairPosition`には自パネルの足の時刻（`priceAtTime`の戻り値`time`）を渡す。発信元の時刻を渡すと例外
- setData直後は`firstValue`未確定で例外になり得る。rAFで1フレーム後に呼ぶ
- メインは`effectiveCursorRef`でcursor以降を切ってから`priceAtTime`へ。nullなら`clearCrosshairPosition`
- サイズ0の非表示パネルでは同期しない
- `param.sourceEvent`無しは同期由来として無視（無限ループ防止）。マウスが外れたら`onMouseLeave`でクリア

**時間軸目盛り・ラベル**
- 時間軸目盛りは全シリーズ時刻の和集合
- 月境界マークは`localization.dateFormat`（有効トークン`yyyy/yy/MMMM/MMM/MM/dd`のみ）
- `tickMarkFormatter`はUTC 00:00判定をしない。`timeframeSec>=14400`は常に日付表示
- 垂直系（区切り線・垂直線）は日付軸欄の手前で止め、日付ラベルを出す線だけ軸欄の帯の中央（ラベル位置）まで伸ばしてラベルと一体に見せる
- 区切り線の日付ラベルはDOM自前描画。表示幅内・土曜以外で最新の1本のみ、cursorより未来の区切りは出さない
- カーソル位置の日付と近い自前ラベル（区切り線・垂直線）は`hideLabelNearCursor`で隠す（しきい値28px）

**データ・約定**
- `read_csv`は`all_varchar=true`/`ignore_errors=true`必須。末尾の0x1A等の制御バイトは`loadCSVFiles`で事前に切り落とす
- DuckDB-wasmはSharedArrayBuffer使用のためCOOP/COEPヘッダ必須（`vite.config.ts`）
- JST変換は集計結果に事後適用。バケット境界はブローカー時間のまま。区切り線は実在の足を境界にする（`computeSeparatorBoundaries`）
- `jumpToTime`は前進時のみ約定判定（判定は`processOrderRange`が1本ずつ）
- `jumpToTime`は通常モードでcursorを戻さない（`Math.max`）。`{rewind:true}`のみ戻す（約定は取り消さない）
- P&Lはクオート通貨のまま
- `rawCsvText`は単一ファイル読込時のみ
- CSV再読込で描画8種・`closedTrades`・`positions`・`pendingOrders`を全リセット。時間軸切替では保持
- BBは`showBB`OFFでも計算継続し`visible:false`。`overlaysHidden`は`visible:false`でなく透明色（オートスケール維持）
- OrderPanelのTP/SL再現は「再現したエントリー価格」基準（現在値基準だとRRが崩れる）

**その他**
- 自動再生は`requestAnimationFrame`（`setInterval`は描画ノイズ）。再生中は毎ステップ`autoScale`再有効化
- フロートパネルの位置クランプは価格軸幅・時間軸高さの実測値をstore経由で共有
- ショートカットは`activePanelSlot`（直近mousedownしたパネル）のみ。`clipboard`は`chart/keyboard.ts`のモジュールスコープで全パネル共有
- dev serverは`preview_start`の使い回しで編集が反映されないことがある。`preview_stop`→`preview_start`

## ビルド / 起動

```bash
npm install
npm run dev        # http://localhost:5173/
npm run typecheck
npm test           # vitest。純粋ロジックのみ（`src/lib/*.test.ts`）。UI・操作系のテストは書かない
```
- 検証コマンド: コミット前に `npm run typecheck` と `npm test`。開発サーバーは `127.0.0.1:5173` をユーザーが起動して使っているので、`preview_start` はポート使用中で失敗する（`navigate` で開く）
- 大きな合成データの検証: 10年分1分足（約375万行）をブラウザ内で生成し `loadFiles([File])` に渡すと実運用規模の確認ができる。ストアは `performance.getEntriesByType('resource')` の `store/useTraderStore.ts` のURLから import して取得する

## TODO / 既知の不具合

- DuckDBバンドルのCDN依存（オフライン不可）
- セッション永続化なし（リロードでCSV再読込が必要、履歴からの自動再読込も不可）
- 20x再生時にヒゲのちらつきが残ることがある（保留）
- 非JPYクオートの損益は円換算しない
