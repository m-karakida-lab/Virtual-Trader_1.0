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
- **デフォルト**: 初回起動時は4画面レイアウト・メイン時間軸15m（2回目以降は1画面/3画面/4画面の選択とメイン時間軸を記憶）。インジケーターはBB・雲・区切り線がON、EMA200はOFF

## 主要機能

### データ読み込み
- Axiory MT4形式 1分足CSVの読み込み（複数ファイル対応、ファイル名昇順で結合）
- ドラッグ&ドロップ読み込み対応（`App.tsx`の`loadFiles`）。この経路はフォルダ履歴には残らない
- フォルダを開いた履歴（Chrome/Edgeのみ、File System Access API、最大12件、`src/lib/openHistory.ts`、IndexedDB保存）。「ファイル選択▾」から直接ファイル選択／フォルダ選択／履歴選択ができる。各履歴行の右端の×で個別に削除可能（`removeFromHistory`）。非対応ブラウザは`<input type=file>`にフォールバックし履歴機能自体出ない
- 読込完了時「✓ N本 読み込み完了」を5秒間表示
- 1分足→任意時間軸への自動集計（DuckDB SQL）。5m/15m/1H/4H/1D/1W/MN切替可。週足・月足はカレンダー基準`date_trunc`集計、それ以外は`floor(ts/sec)`固定長バケット集計
- 表示は日本時間(JST)に変換済み。CSV（ブローカーサーバー時間）はEU夏時間ルール（GMT+2冬/+3夏）前提で自動変換。チャート・日付ジャンプ・取引履歴すべてJST基準
- 通貨記号はファイル名（例`EURUSD_2025_all.csv`）から自動検出。実際の円換算はしない
- 書き込み（水平線・垂直線・四角形・トレンドライン・ブラシ・テキスト）の保存/読込: 単一ファイル読込時のみ「💾 vtd保存」ボタンが現れ、CSV＋描画データJSON＋決済済み取引履歴（closedTrades）＋再生位置（cursorTime、保存時点の最新足のUnix秒）を`.vtd`1ファイルに保存（`src/lib/vtd.ts`）。元がvtdバンドルだった場合のみ「上書き保存」でそのファイルへ直接書込み、素のCSVを開いた場合は常に新規ダウンロード。複数ファイル同時読込時は保存機能自体使えない。上書き保存が1回成功すると自動保存が武装（`autoSaveArmed`）され、以降10分ごとに前回保存内容と差分があれば同じファイルへ自動で上書き保存する（`App.tsx`のタイマー→`store.autoSaveTick`、新しいファイルを読み込むと武装解除）。建玉中のポジション・未約定注文・残高/初期残高等の「設定」は保存対象外（残高は読込時に初期残高＋復元した取引の損益合計で再計算）。読込時、cursorTimeは現在の時間軸のcandlesへ二分探索（`findCursorForTime`）で引き直してcursorを復元（保存時と異なる時間軸で開いても対応）、無ければ従来通りcursor:0から。ズーム位置は別途localStorageで時間軸ごとに記憶（vtdファイルには含まない）

### チャート表示・描画
- ATR(14)バッジ（`computeATR`、`src/lib/indicators.ts`）: 今のボラティリティの目安をpips換算した数値1個だけをパネルヘッダー右上、日付ピルの左に表示（サブパネルやプロット線は無し）。Wilderのスムージングで算出、各パネル自身の時間軸・今の位置（メインはcursor、非メインは自前集計データの末尾）を基準に毎回フルスクラッチ計算（直近の一定範囲だけ遡れば十分収束するため増分保持は不要）。表示本数が期間未満の間は非表示
- インジケーター: 200EMA（増分計算、デフォルトOFF）、SMA14（増分計算、デフォルトOFF）、ボリンジャーバンド（期間20、増分計算、デフォルトON）、一目均衡表の雲（先行スパンA/Bのみ、26本先行、デフォルトON）。ロウソク足（`chart.addCandlestickSeries`）はこれらEMA/SMA/BB/雲の境界線Seriesより**後**で追加すること（lightweight-chartsは後から追加したSeriesほど上に描かれるため）——重なった時にロウソク足を上に見せたいという要望に対応（`CandleChart.tsx`のチャート初期化部）。雲の塗りつぶし自体はSeriesではなく専用canvas（`cloudCanvasRef`、`syncCloud`）への自前描画のためSeries順序の影響を受けず、共通ヘルパー`cutCandlesFromCanvas`（下記参照）でロウソク足と重なった部分を透明に抜く、区間区切り線（5m/15m/1Hは日替わり・4Hは週替わり・1D/1Wは月替わり・MNは年替わり、デフォルトON）、東京/ロンドン/NYセッション帯（JST 9-16/16-22/22-7時、重複なし。全期間スクラバーの少し上に、同じ太さ（高さ4px）の1行で濃い色表示、所属セッションの帯だけ不透明度を上げて濃く見せる演出、現在足の位置に白い縦線の目印（帯の上に離して配置、重ねない）、日足以上では非表示、デフォルトON）。全て4画面時のミニパネルにも連動（`src/lib/indicators.ts`・`src/lib/weekLines.ts`・`src/lib/sessions.ts`共有）。区切り線・セッション帯はDOMオーバーレイ（`weekOverlayRef`/`sessionOverlayRef`ともzIndex:8、四角形のcanvas zIndex:9より下）
- 描画ツール起動: アイコンパネル（水平線・垂直線・ものさし・四角形・トレンドライン・ブラシ・テキスト、`src/components/DrawToolbar.tsx`）をワンクリックで有効化しチャート上のクリック/ドラッグで配置（配置後自動解除）。「連続描画」（鍵アイコン、`continuousDrawing`）ONで同じツールを解除せず連続配置可能。配置直後は必ず選択状態に入りパレットでその場編集できる。テキストのみ編集セッション継続のため次を置くには一旦クリックアウトしてから再クリックが必要。表示位置はチャート領域左の専用列（`App.tsx`）
- 水平線・垂直線のラベル表示ON/OFF（`showHLinePriceLabel`/`showVLineDateLabel`、`vt:lineLabels`保存）: 個別でなく全水平線/全垂直線一括の設定。垂直線ラベルは日付軸欄にDOM表示（`yy M/D hh:mm`形式）。デフォルト両方ON
- マグネット（`magnetMode`、デフォルトON）: 弱＝カーソルがOHLCの12px以内で吸着、強＝常に直下の足の最寄りOHLCへ吸着。ON/OFF自体は永続化せず毎起動ON、強さのみ`vt:magnetStrength`に保存。対象は水平線の配置/移動、四角形の描画/リサイズ（垂直線・ものさし・TP/SL編集は対象外）
- ジャンプモード（3画面/4画面のみ、`isJumpSync`）: 描画ツールバー最下部の的アイコン。ONで足をクリックすると、クリックしたパネル以外の表示中パネルだけその時刻へ移動。使用後は自動OFF。移動先は各パネル自身の`displayCandlesRef`に対する二分探索で算出。ジャンプ後は`captureFollowAnchorRef`（非メインの巨大effect内の`captureFollowAnchorFromCurrentView`を公開するref）でその位置を新しい`followAnchorRef`として採用する——ここを更新しないと、ジャンプ後に別パネルをメインへ昇格させる等でnonMainVisibleの参照が変わった瞬間、非メインパネルの「常時追従」effectが古いアンカー（ジャンプ前の位置）で再発火し、ジャンプした表示が勝手に最新足へ戻ってしまう不具合になる（実際に踏んだ）。同じ理由で、メインパネルが「最新足に固定」OFFのまま任意の位置へ動いた（ジャンプ・手動パン等）後に**降格**（別パネルが昇格）する瞬間にも`captureFollowAnchorRef`を呼ぶこと——メインの間は`followLatest`がOFFだと`captureFollowAnchorFromCurrentView`のガードで弾かれ`followAnchorRef`が一度も更新されないため、降格した瞬間にその場のアンカーを採用しないと非メインの「常時追従」effectがnull＝アンカー未設定と判定し最新足へ飛んでしまう（`isMain`がtrue→falseに変わった瞬間を検知して`CandleChart.tsx`のprops同期effect内で呼ぶ）
- パレットモード（`paletteMode`、デフォルトOFF）: 図形を選択すると自動ON、選択解除で自動OFF。選択中図形の色・線種・太さをその場で変更可能。変更値は対応する各種Draft（`lineDraft`等）にも同期し次の新規配置のデフォルトになる。図形未選択でもツール起動中（配置前）ならパレットを表示しDraftへ直接反映する
- 水平線・垂直線描画: クリック配置、ドラッグ移動。配置直後自動選択。選択中にDelete/Backspaceで削除、Cmd/Ctrl+C→Vで右下にずらして複製。垂直線・水平線とも線本体は専用canvas（`vlineCanvasRef`/`drawVLineCanvas`、`hlineCanvasRef`/`drawHLineCanvas`）に自前描画し、共通ヘルパー`cutCandlesFromCanvas`でロウソク足と重なった部分を透明に抜く（ロウソク足が手前に見える）。日付ラベル・選択ハンドルは従来通りDOM（`overlayRef`）のまま。水平線は`createPriceLine`自体は残しているが`lineVisible:false`で線本体だけ隠し、価格軸のラベル（`axisLabelVisible`）表示専用に使っている（価格軸ペインはこのcanvasの対象外でSeries Primitives制約を受けないため）
- 垂直線の位置計算は`timeToXSnapped`（`timeToX`とは別関数）を使うこと。`timeToX`は足と足の間の時刻を線形補間するため、他時間足のパネル（例: 1Hで引いた線を4Hパネルで見る）では足と足の隙間を指してしまう。`timeToXSnapped`はその時刻を含む足（floor側）へスナップする。描画（`drawVLineCanvas`/`syncVLines`のDOMラベル）・選択ハンドル・当たり判定（`findVLineNear`）の3箇所すべてで同じ関数を使うこと——1箇所だけ変えると見た目の線とクリック判定がズレる
- 水平線・四角形の表示時間足設定（`hiddenTimeframes`、選択時のみPalettePanelにボタン列で表示）: 1H/4H/1D/1W/MNを個別にON/OFF、デフォルト全部ON（全時間足表示）。1HをOFFにすると5m/15mも連動して非表示になる（`isHiddenTimeframesVisibleAt`、`CandleChart.tsx`。水平線・四角形で共通の判定関数）。新規配置直後は常に全部ONで、配置後に選択して個別にOFFにする運用
- パレットの色順は`LINE_COLORS`（`types.ts`）で固定: 赤→黄→ティール→青→紫→ピンク→グレー→白。四角形/トレンドライン/ブラシのデフォルト色は`LINE_COLORS[3]`（青）参照——並び順を変える時はこのインデックスも合わせて直すこと
- 四角形描画: ドラッグで対角に描画。色/線種/太さは共通パレット（`LINE_COLORS`8色）。4隅/4辺ドラッグでリサイズ、枠線ドラッグ（`findRectBorderNear`）で平行移動。平行移動は秒数でなく足インデックス差分で計算（週末の足抜け対策）。ヒット許容半径は`RECT_HANDLE_HIT_PX=12`。枠線本体は専用canvas（`rectCanvasRef`、トレンドライン等と同じDOMオーバーレイ方式）に自前描画（グリッド線・標準の価格ラインより上に出したいためSeries Primitivesは使わない——詳細は不変条件/地雷を参照）。縦線・横線とも描いた直後に共通ヘルパー`cutCandlesFromCanvas`（下記参照）で重なった部分だけ透明に抜く（TradingView同様、ローソク足と重なった部分はローソク足が優先表示される）。選択中のリサイズハンドルのみ別レイヤーのDOM（`rectHandleOverlayRef`）
- トレンドライン描画: ドラッグで2点の線分。専用`<canvas>`（`trendCanvasRef`）に描画。端点ドラッグでリサイズ、本体ドラッグで平行移動（足インデックス基準）
- 平行チャネル描画（`DrawnChannel`、専用`<canvas>`＝`channelCanvasRef`）: 1回目のドラッグで基準線（トレンドラインと同じ2点構造）を引き、続く1クリックで2本目の線までの価格オフセットを確定する2段階操作。オフセットは画面ピクセルの垂直距離ではなく価格差として持つため、ズーム/スクロールしても常に平行を保つ。基準線の端点ドラッグでリサイズ（オフセット不変）、基準線本体ドラッグで全体を平行移動（オフセット不変）、2本目の線本体ドラッグでオフセットだけ調整——という3種類の編集ができる
- 矢印描画: トレンドラインと全く同じ2点構造・操作性（専用`<canvas>`＝`arrowCanvasRef`、端点リサイズ/本体移動とも同じ実装）。終点（矢先）に三角形の矢印ヘッドを描き、特定の足を指し示す用途。四角形/トレンドライン/ブラシより常に上に表示・優先して掴める（zIndex 10、当たり判定も最優先）
- ブラシ描画（フリーハンド）: ドラッグ軌跡を点列（`DrawnBrush.points`）として記録、専用`<canvas>`（`brushCanvasRef`）に2次ベジェで平滑化描画。ピクセル距離基準（`BRUSH_MIN_PX=2px`）で間引いて記録。座標変換は足の内側でも連続値を返す`pixelToContinuousTime`を使用。描画直前にボックスフィルタ12パスで手ブレ補正。移動は素の時間差分（足インデックス基準ではない）
- ブラシの図形認識（`src/lib/shapeRecognition.ts`）: ストローク確定時、閉じている（始点-終点が近い）かをまず判定し、Douglas-Peuckerで単純化した頂点数が3なら三角形（`DrawnBrush.shape:'triangle'`、直線で描画・平滑化なし）、単純化してもなお頂点数が多く半径のばらつきが小さければ円（`shape:'circle'`、バウンディング楕円の点列に置き換え）にスナップする。判定はピクセル座標で行う（time/price空間はスケールが違うため）。どちらにも該当しなければ通常のフリーハンドのまま
- 図形認識で作った三角形/円は選択中に専用ハンドルで再編集できる: 三角形は各頂点（`points[0..2]`、`points[3]`は始点の複製として追従）、円はバウンディングボックスの4角（ドラッグで対角を固定し楕円の点列を再生成）。普通のフリーハンド（`shape`なし）は従来通り全体移動のみ
- テキストボックス描画: クリック配置と同時に編集モード。`contentEditable`直接編集（`window.prompt`不使用）、Enterは改行（`document.createTextNode('\n')`挿入）。IME変換確定のEnter（`e.isComposing`/自前追跡の`isComposingNow`/`keyCode===229`のいずれか）は常に素通しし、確定のみで改行はしない（変換確定と改行を1つのEnterに統合しようとしたが、1回目と2回目以降で挙動が食い違う不具合が残り、そもそも「確定は常に確定のみ、改行は別途もう一度Enter」が意図した挙動だったため撤回した）。空文字のまま確定/Escapeすると削除扱い。文字サイズ4段階（14/18/24/32px）・枠線スタイルはパレットで変更可
- テキストボックスが空の間は「文字を入力」というプレースホルダーを薄い文字（#666）で表示する（CSS `.vt-text-editable:empty::before`、`index.css`）。全消去時に`<br>`等の残骸が残ると`:empty`に合致しなくなるため、input時にtextContentが空ならinnerHTMLごと空にして常に完全な空にしておく
- Undo（Cmd/Ctrl+Z）: 全描画要素の追加・移動・リサイズ・削除・複製・スタイル変更を1手ずつ戻せる（`drawHistory`、最大50件）。Redoは未実装。CSV再読込でリセット
- 価格軸ドラッグへの追従: 縦スケール変更時、垂直線・四角形・トレンドライン・ブラシ・テキスト・雲の位置が追従（window mousemoveのフォールバック同期）
- ものさし: ドラッグで価格差・pips・%・本数・期間・中央線を計測。1回ドラッグで自動解除。ホイールクリック（中央ボタン）ドラッグでも計測可。符号・色はドラッグの始点→終点基準
- 価格軸の表示精度はペアの価格帯から自動判定（JPYクロス=小数3桁、それ以外=小数5桁）
- チャート全表示: `cursor`を最後の足まで進める（`advanceToEnd`、通過範囲の注文約定・TP/SL判定も一括処理）。末尾にいる間は発注パネル・速度スライダーを無効化
- 表示をリセット: 時間軸ズームを`resetTimeScale()`でデフォルトに戻し価格軸を`autoScale:true`に戻す。画面中心の足の位置は変えない
- 最新足に固定（`followLatest`）: 各パネルの縮尺を維持したまま最新足を右オフセット位置に表示し続ける。組み込み`scrollToRealTime()`は使わず`setVisibleLogicalRange`で自前計算（`applyLatestViewRef`）。頭打ち基準はCSV全期間本数。1枠で手動パン/ズームするとそのパネルの`followAnchorRef`だけ更新。非メイン（4画面の他3枠）は`followLatest`トグルに関わらず常時追従（メインのみトグル依存）
- `followAnchorRef`はfollowLatestがfalseになっても（`stepBack`等が自らfalseに戻すため）nullに戻さないこと。`stepBack`/`jumpToTime`はメイン側のデータ同期effectで「直前まで固定されていたか」を`followAnchorRef`の非nullで判定し、非nullなら組み込み`scrollToRealTime()`ではなく`applyLatestViewRef`で位置を確定する——ここでnullに戻すと2回目以降の戻る操作で毎回既定位置へジャンプする。再捕捉は「最新足に固定」ボタン押下時のみ
- 日付ジャンプ（📅ボタン）: 日付のみ指定、常にその日00:00へジャンプ。縮尺維持で中心移動。「移動」は過去日付でも`cursor`を戻さず表示位置のみ移動、未来日付は`cursor`も進め通過範囲の約定判定を行う。「巻き戻し」は指定日付を新しい最新足にする（`cursor`をそのまま指定日付へ戻し、それより先の足を隠す。約定済みの注文・決済は取り消さない）
- 画面キャプチャ: 「📷 キャプチャ」ボタンでチャート領域（`#vt-chart-capture-area`）をJPEGダウンロード（`src/lib/screenshot.ts`、`html-to-image`の`toJpeg`、`pixelRatio:1`/`quality:0.5`）。フローティング操作パネルは`EXCLUDED_IDS`で除外
- 全期間スクラバー: チャート下端の細いシークバー（メインパネルのみ）。つまみドラッグで平行移動、余白クリックでその位置へジャンプ。`setVisibleLogicalRange`を直接呼びstore/cursorには触れない
- 1画面/3画面/4画面レイアウト切替: 選択状態は`vt:chartLayout`に記憶。3画面と4画面は各枠の時間軸・メイン枠を完全に別管理（`quad3Timeframes`/`quad3MainSlot`を`vt:quad3`、`quad4Timeframes`/`quad4MainSlot`を`vt:quad4`に個別保存）、切り替えてもお互いの状態に影響しない。4画面は2x2固定（デフォルト左上15m・左下1H・右上4H・右下1D）。3画面は枠0=大きい枠+枠1,2=残り2枠の3枠構成（枠3は常に非表示、デフォルト15m/1H/4H）、配置パターンは`quad3Pattern`（`vt:quad3pattern`）で`left`（左1枠縦通し+右上下2枠）/`top`（上1枠横通し+下左右2枠）を切替（下部バーの⇄ボタン）。パターンを切り替えても枠0-2の時間軸・メイン枠（`quad3Timeframes`/`quad3MainSlot`）は共有されたまま、見た目の配置だけ変わる。`setChartLayout`は表示中のマルチ画面が実際に切り替わる時だけ、切替先が最後に使っていたメイン時間軸へ`setTimeframe`で実データも切り替える（同じレイアウトへの1画面往復では何もしない）。メイン枠のみ青枠で強調。4枠は常に同じ`CandleChart`をマウントし続けCSSで表示/非表示を切替（remountせずズーム/スクロール位置を保持）。パネルの実サイズが変わる際は`handleResize`がスケール（barSpacing）維持のまま表示本数を調整し中心の足を保つ。パネルヘッダーのドロップダウンで時間軸切替可能、切替時は切替先の時間足自身の前回のズーム（`vt:chartView:<timeframeSec>`）を復元する（直前の実時間範囲は引き継がない——引き継ぐと1H→15mのように細かい方へ切り替えた時に足が小さく潰れて見えるため）。パネル本体クリックでそのパネルをメインへ昇格（`promoteSlotToMain`、呼び出し時点の`chartLayout`が'3'か'4'かで対象を判定、自前集計済みデータを再利用しDuckDB再クエリを省略）。非メインパネルは確定済みの足に加え、メインの確定済み足から自前集計した形成中の足も末尾に表示する（未来分は含めない先出し防止）。メインへ昇格する瞬間は「今」の時刻を保持したまま切り替わり、直後にもう一方へ戻せば状態は変化しない（`mainRevealedUntil`）。描画の新規/選択/移動/削除・Delete/Undo/コピペは全パネルで動作するが、キーボードショートカットは直近マウス操作したパネル（`activePanelSlot`）にのみ効く。1画面化からの復帰先レイアウト（3画面/4画面）は`preMultiLayout`に記憶
- TradingView風パネルヘッダー: 左上に「シンボル（ファイル名から検出）+時間足」表示。🏷ボタンでそのパネルの時間足のトレード履歴マーカーを表示/非表示。`store.tradeMarkersVisible`は時間足(sec)をキーにしたマップなのでパネル位置ではなく時間足単位で連動する。右上の現在時刻表示（`ChartHeader.tsx`の`fmtCurrentTime`）は「YYYY/MM/DD(曜) HH:mm」形式で曜日も表示する
- トレード履歴マーカー（エントリー/決済）: lightweight-charts標準のシリーズマーカーではなく、セッション帯と同じ下部の専用行にDOM要素（番号ラベル「#N」のみのタグ、損益は非表示）で描く（`syncTradeMarkers`、`CandleChart.tsx`）。ローソク足・インジケータと重ならない。セッション帯が出ている時はさらにその上（帯より上に出る現在足の白い縦目印より上）、非表示時はスクラバーのすぐ上に積む。各タグからそのエントリー/決済価格の位置まで点線の縦線で繋ぎ、どの足のマーカーか分かるようにする。DOM要素なので直接onclickで取引履歴へジャンプ（canvas近似当たり判定は無し）
- ズーム/スケールの記憶: 時間軸ごとにパン・ズーム位置をlocalStorage保存、次回はどのデータを読み込んでも同じ拡大率で復元。パン位置は復元せず常に最新足に固定。保存済み本数（span）は実本数を超えないよう頭打ち（`relativeViewToLogicalRange`）。保存ビューが無い場合のフォールバック基準は`nonMainVisible`（実際にsetDataした本数）。保存ビューがある場合のクランプ基準は`nonMainCandles`/`candles`（CSV全期間本数）
- 3画面/4画面時の十字カーソル同期: いずれか1枠を実際にホバーすると他の表示中パネルにも同時刻の十字カーソルを表示（`chart.setCrosshairPosition`）。価格は各パネル自身の直前終値。ホバー先にその時刻が存在しない場合は非表示
- 十字カーソルは`CrosshairMode.Normal`（データ点への吸着なし、空白領域でも表示）

### 再生
- ▶（自動再生・1〜20倍速、`requestAnimationFrame`実装、速度はlocalStorageに記憶）/ ⏭（1コマ進む）/ ⏮（1コマ戻る、表示のみ・約定は取り消さない）
- フロート操作パネル: チャート上にドラッグで自由配置できる再生ボタン群。価格軸・時間軸の領域には重ならないようクランプ
- 再生中は右価格軸の`autoScale`を毎ステップ再有効化し縦方向のはみ出しを防止

### 発注・トレード
- 成行/指値/逆指値を選択して発注。指値・逆指値は現在値との上下関係を検証（不正な方向はエラー表示）。TP/SLもBUY/SELLに対してあり得ない向き（例: BUYで建値より下のTP）は発注時に弾く
- `submitOrder`はbooleanを返す（成立したらtrue）。発注パネルの「注文執行」は失敗時（残高不足・TP/SLの向き矛盾等）は自動で閉じず、`error`をパネル内にも表示する（`OrderPanel.tsx`）。パネル表示中は画面上部の共通エラートースト（`App.tsx`）は同じ内容の二重表示を避けるため出さない
- TP/SLを発注時に設定可能。未約定の指値・逆指値にも約定前からTP/SLを表示・ドラッグ調整可能。チャート上のTP/SL価格ライン（建玉・未約定注文・draftプレビューいずれも）はタイトルにエントリー価格からのpips数も表示する（`pipsBetween`、`CandleChart.tsx`）
- 建玉中は各ポジションのエントリー価格も実線の価格ラインで表示（`positionEntryLineMapRef`、色はBUY/SELLで区別、TP/SLの破線とは別スタイル）。決済すると自動で消える
- TP/SL・指値/逆指値の価格はチャート上で📍ボタンからクリック取得、またはドラッグで調整可能
- ロット指定: 固定ロット or リスク%モード（残高×リスク% ÷ |エントリー価格-SL| で自動計算、デフォルト3%）
- リスクリワード（R:R）プレビュー: draft中のエントリー・TP・SLから値幅を色付きボックスで可視化、比率を表示
- 発注パネルの「価格」「TP」「SL」（draft値）はいずれか1つでも入力済み・またはPickモード中なら「クリア」ボタンが現れまとめて空にできる
- 複数ポジション同時保有可能、個別決済/全決済
- 決済済みトレード（`ClosedTrade`）はエントリー時点のTP/SLも保持する（`tp?`/`sl?`、これより前のvtd/セッションには無いため任意）。リスクリワード比（`plannedRR`、`src/lib/tradeStats.ts`）はこれを使い「1 : reward/risk」で算出、TP/SLが両方揃っている時のみ計算可能
- エントリー・決済マーカー: チャート上に矢印（エントリー）と円（決済、損益付き）を表示。決済済みトレードは`closedTrades`に履歴保存。マーカーテキストの「#N」は取引履歴パネルの#列と同じ採番（closeTime昇順）。マーカークリックで取引履歴パネルを開き該当行までスクロール＋ハイライト、ホバー中はカーソルがpointerに変わる（当たり判定は共通関数`hitTestTradeMarkerAtTime`＝時刻・高値/安値からのY距離の近似判定、クリックは`chart.subscribeClick`→`store.openHistoryForTrade`/`scrollToTradeId`、ホバーはmousemoveの既存カーソル切替チェーンから利用）
- 取引履歴パネル（表示順: 残高の推移→リスクとパフォーマンス指標→パフォーマンス分析→セッション別分析→曜日別分析→保有期間帯別分析→取引内容一覧）: エクイティカーブ（損益推移の線グラフ）/収入・トレード数・時間（平均保有期間・勝敗別平均保有期間を含む）・その他4カテゴリの指標（純利益・PF・最大DD・連続勝敗数等）/総取引数の勝敗・ロング/ショート件数・方向別利益（横棒グラフ付き）/東京・ロンドン・NY別の取引回数・損益（エントリー時刻基準）/エントリー曜日別（月〜金の5区分、土日にずれ込んだ分は直前/直後の平日に合算）の件数・損益/保有期間帯別（1時間未満〜7日以上の6区分、デイトレ〜スイングを想定）の件数・損益/取引一覧テーブル（#番号・方向・ロット・価格・保有期間・R:R・獲得(損失)pips・損益、行クリックでそのトレードのエントリー時点へチャート表示を移動）。パネル全体が1つのスクロール領域。「📊 AI分析用エクスポート」ボタン（`src/lib/aiExport.ts`）: このアプリを知らない外部AI（ChatGPT/Claude等）にそのまま読み込ませられるよう、用語・前提の説明文＋集計指標＋取引一覧全件をMarkdownファイルとして書き出す（アプリ内にAIは組み込まない）。
- 保有中の振れ幅・損切り後の値動き（`src/lib/tradeExcursion.ts`）: MAE/MFE（保有中の最大含み損/益）と、決済後12h/24h以内にエントリー方向へ最大何pips戻った/さらに逆行したかを1分足まで遡って事後計算（バックテストなので決済後データも既知、リアルタイム追跡は不要）。DuckDBへの非同期クエリのため取引履歴パネルを開くたびに`useEffect`で再取得（`ClosedTrade`型自体は変更しない、純粋な導出データ）。集計値はパネル新セクションとAIエクスポート両方に表示、生の値はAIエクスポートの取引一覧列にのみ追加（画面上のテーブルには出さない）。あくまでヒンドサイト分析である旨をAIエクスポートの取説に明記曜日別・保有期間帯別は「意外な気づきがあれば」という位置づけの試験的な指標で、合わなければ削除する前提（`src/lib/tradeStats.ts`のHOLD_BUCKETS/WEEKDAY_LABELS）

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
TIMEFRAMES: [{sec:300,label:'5m'}, {sec:900,label:'15m'}, {sec:3600,label:'1H'}, {sec:14400,label:'4H'}, {sec:86400,label:'1D'}, {sec:604800,label:'1W'}, {sec:2629746,label:'MN'}]
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
- `src/lib/vtd.ts` — CSV＋描画データ＋決済済み取引履歴の1ファイル化（`splitVtdBundle`/`buildVtdBundle`）。区切り文字列より前は通常CSVのまま。取引履歴を含まない旧形式ファイルは空配列にフォールバックして読み込める
- `src/lib/chartTheme.ts` — TradingView風チャート共通スタイル定数（フォント・軸文字色/サイズ）
- `src/lib/chartViewState.ts` — ズーム/スケールを時間軸ごとにlocalStorage保存/復元（絶対時刻でなく相対位置）
- `src/lib/indicators.ts` — EMA/SMA/BB/雲の全体再計算版（CandleChartは別途増分計算の最適化版を持つ）。雲のずらし先時刻`cloudDisplacedTime`のみCandleChart共通利用
- `src/lib/weekLines.ts` — 区間区切りの境界計算（`computeSeparatorBoundaries`、MN=年区切り、1D/1W=月区切り、4H=週区切り、5m/15m/1H=日区切り）
- `src/lib/sessions.ts` — 東京/ロンドン/NYセッション帯の時間帯計算（`computeSessionBands`、`weekLines.ts`の`computeDayBoundaries`を流用して実データに存在する日ごとに帯を作る）。`sessionKeyAt(sec)`は任意の時刻がどのセッションかを判定（取引履歴のセッション別分析で使用、チャート表示ロジックとは独立）
- `src/lib/shapeRecognition.ts` — ブラシの図形認識（`recognizeShape`）。AI不使用、Douglas-Peucker単純化＋半径のばらつきによる古典的幾何判定のみ
- `src/lib/pips.ts` — 価格帯からpip単位・表示精度を推定
- `src/lib/crosshairSync.ts` — 4画面十字カーソル同期用（`priceAtTime`、範囲外はnull）。戻り値の`time`は発信元パネルの時刻ではなく実際にマッチしたこのパネル自身の足の時刻（`setCrosshairPosition`には自パネルの足の時刻を渡すこと。発信元の時刻をそのまま渡すと時間軸が違うパネル間で内部の座標解決に失敗し例外を投げる不具合を実際に踏んだ）
- `src/lib/openHistory.ts` — File System Access APIでフォルダを開いた履歴の保存/復元（IndexedDB）
- `src/lib/screenshot.ts` — チャート領域（`#vt-chart-capture-area`）をJPEG保存（`html-to-image`のラッパー）
- `src/store/useTraderStore.ts` — 全アプリ状態＋アクション。注文約定・TP/SL判定は`processOrderRange`（高安レンジ判定、SL優先）。チャート操作はシグナルパターン（`fitSignal`/`centerSignal`/`scrollToLatestSignal`をincrement→CandleChartのuseEffectが検知）
- `src/components/CandleChart.tsx` — lightweight-chartsラッパー。`{slot, isMain, timeframeSec}`propsを取る。**足データ取得経路がisMainで2分岐**: isMain=trueはグローバル`candles`/`cursor`を使い増分計算最適化、isMain=falseは`queryCandles`で自前集計（`nonMainCandles`）しメイン現在足の閉時刻までクリップ（`nonMainVisible`、先出し防止）し共有フル計算で毎回再計算。確定済み足に加え、形成中（未確定）のバケットもメインの確定済み足（0..cursor）だけから自前集計して末尾に1本追加する——確定するまで何も出さないと上位足の表示が数日分遅れて見えるため。バケット開始時刻は`floor(time/timeframeSec)`を自分で計算し直さず`nonMainCandles`から引く（ブローカー時間バケット境界とJST表示ズレの地雷を踏むため）。4画面でのremountなしのprops切替に対応するため`isMainRef`/`slotRef`/`mySourceIdRef`を軽量effectで同期し、初期化effect内は必ずこれらのrefを読む。全パネルでドラッグ/当たり判定・配置・テキスト編集・Delete/Undo/コピペが可能、ショートカットは`activePanelSlot`（直近mousedownしたパネル）にのみ効く。`clipboard`はモジュールスコープで全インスタンス共有。メイン昇格直後は最新足への強制ジャンプを1回スキップ（`wasMainForDataSyncRef`）、降格直後は非メイン同期の初回フィットを1回スキップ（`skipNextNonMainFitRef`）
- `src/components/MiniChart.tsx` — 現在未使用（`App.tsx`から参照削除済み、ロールバック用に残存）。全パネルが`CandleChart`に統一されたため退役
- `src/components/ChartHeader.tsx` — パネル左上の「シンボル+時間軸」表示＋全画面切替ボタン。時間軸ラベルクリックでドロップダウン開閉。全画面ボタンは非メイン枠なら`promoteSlotToMain`後に1画面化
- `src/components/Controls.tsx` — 時間軸/表示モード/インジケータ切替/ポジション・注文一覧/口座情報。各種設定は`MenuButton`ポップアップ（画面外クリックで閉じる）に集約。「発注」ボタンは`OrderPanel.tsx`（別コンポーネント、下記）の開閉トグルのみ。下部「インジケータ」メニューはEMA/SMA/BB/雲/区間区切り/セッションのトグルのみ（描画物の一覧/削除は`DrawToolbar.tsx`へ移設）
- `src/components/OrderPanel.tsx` — 発注パネル本体。`PalettePanel.tsx`と同じくチャート上に独立して浮かぶドラッグ可能なパネル（`store.orderPanelOpen`で開閉、注文執行で自動的に閉じる）。行を「注文(成行/指値/逆指値)・数量(固定/リスク%)・TP・SL・方向(BUY/SELL)・注文執行」に分離。BUY/SELLは方向を選ぶだけのトグル（`selectedSide`）で即発注はせず、「注文執行」ボタンで確定する2段階操作（誤クリック防止）。位置は`src/lib/orderPanelPos.ts`経由でlocalStorage（`vt:orderPanelPos`）へ保存し次回も復元する（PalettePanelの位置はマウント中のみの記憶で保存されない点と異なる）。パネルを開いた時・注文種別/方向を切り替えた時、その組み合わせ（`store.lastOrderRatiosByKey`、`${orderType}:${side}`キー、エントリー価格からの価格/TP/SLの距離%）の前回発注を現在値に適用し直した値を価格/TP/SLへ仮入力する（切り替えるたびに既存の入力値も上書きする。その組み合わせの履歴が無ければ何もしない）。TP/SLの基準は現在値ではなく「今回再現するエントリー価格」（指値/逆指値は再現したdraftPrice）にすること。現在値基準にするとRRが崩れる
- 再生・1コマ戻る・1コマ進むボタンは、以前はチャート上に浮かぶドラッグ可能な丸ボタン群（`FloatingControls.tsx`）だったが、下部ボタン行（`Controls.tsx`、📅日付移動と⚙設定の間、左から再生/戻る/進む）へ統合し`FloatingControls.tsx`は削除した
- `src/components/DrawToolbar.tsx` — 描画ツール起動アイコンパネル。クリックで`isDrawingLine`等のstore状態をトグルするのみ、実際の配置/描画は`CandleChart`側が担う。「一覧」アイコン（`DrawnObjectsPopup`）で既存図形（水平線/垂直線/四角形/トレンドライン/ブラシ/テキスト）を種類別に縦一覧表示し選択/削除（`maxHeight`+縦スクロールで件数超過に対応、下部バーを圧迫しない）。最下部の目アイコンで`overlaysHidden`を一括トグル（EMA/SMA/BB/雲は色を透明化しオートスケールジャンプを回避、描画物はvisibility切替）
- `src/components/PalettePanel.tsx` — パレットモードON時のみ表示するドラッグ移動可能なスタイル選択ウィンドウ。図形との同期は`store`の`syncPaletteStyleFrom`/`applyPaletteStyleTo`が担う
- `src/components/HistoryPanel.tsx` — パフォーマンス分析（SplitBar/SignedBarRowの簡易横棒グラフ）＋リスクとパフォーマンス指標（`tradeStats.ts`の計算結果を表示するだけ）＋エクイティカーブ＋取引履歴テーブル（オーバーレイパネル）
- `src/lib/tradeStats.ts` — 取引履歴のリスク・パフォーマンス指標を計算する純粋関数（`computeTradeStats`）
- `src/components/FileLoader.tsx` — 「ファイル選択▾」ドロップダウン（開く履歴）＋「💾 vtd保存」ボタン
- `src/components/ErrorBoundary.tsx` — レンダー/エフェクト中の例外を捕捉し黒画面の代わりにエラー内容を表示（`main.tsx`でApp全体を包む）
- `src/lib/errorLog.ts` — 例外をlocalStorage（`vt:errorLog`、直近20件）に記録。`window.onerror`/`unhandledrejection`とErrorBoundary両方から書き込む。加えて`errorLogFile.ts`経由で実ファイルへも追記を試みる（ベストエフォート）
- `src/lib/errorLogFile.ts` — エラーログの実ファイル追記（Chrome/Edge限定、File System Access API）。選んだファイルハンドルは専用DB（`virtual-trader-errorlog`、openHistory.tsのDBとは分離）にIndexedDB保存。2MB超で末尾半分だけ残して自動切り詰め（古いログの自動削除）。UIはControls.tsxの「🪲 ログ」メニュー（保存先選択/解除、「ログファイルを開く」で新規タブに中身を表示、「ログをクリア」でファイル+localStorageの両方を消去。未選択時はlocalStorageリングバッファにフォールバック）

## 不変条件 / 地雷

- DOMオーバーレイ（雲・トレンドライン・矢印・ブラシ・垂直線・テキスト・四角形・週区切り線等）は`right: chartRightMargin`pxで価格軸を、`chartBottomMargin`で日付軸欄を避けること（`inset:0`等で全面に広げない）
- 選択中の水平線・四角形の編集ハンドル（`syncVLines`の中点ハンドル、`syncRects`のリサイズハンドル）や当たり判定（`findRectBorderNear`等）は、本体の描画フィルタとは別経路で組んでいるため、`hiddenTimeframes`を持つ図形の種類を増やす/触る時は本体の描画箇所だけでなくこれらにも`isHiddenTimeframesVisibleAt`を入れること。入れ忘れると、その時間足で非表示に設定した図形を選択中の場合だけハンドルが残る・非表示のはずの図形がクリックに反応する、という不具合になる
- 描画要素の種類を増やす時は`useTraderStore.ts`の`pushDrawHistory`/`undo`/`DrawSnapshot`/`loadFiles`/`saveChartFile`/`vtd.ts`の6箇所に配列とnextIdを必ず追加すること（`undo`だけ追加し忘れ、矢印を消してもUndoで戻らない不具合を実際に踏んだ）
- `CandleChart.tsx`内の巨大effect（マウント時1回だけ実行）で新規図形の`syncXxx`関数を追加する時、その関数が参照する`let`宣言（ドラフト/プレビュー用の状態）は`syncXxx`の定義より**前**に置くこと。`syncXxx()`はeffect内で即座に呼ばれるため、後方の`let`を参照するとTDZ（Temporal Dead Zone）で`Cannot access 'x' before initialization`になる（平行チャネル追加時に実際踏んだ）。同じ理由で`DASH_TO_CANVAS`等、複数のcanvas描画箇所が使う定数はコンポーネント内のローカルconstにせずモジュールレベルに置くこと（垂直線のcanvas化で同じTDZを踏んだ）
- 一部の証券会社CSVは末尾にDOSのEOFマーカー（0x1A）が付いており、これを含むとDuckDBのCSVパーサーが「state machine reached an invalid state」で全体読み込みに失敗する（`ignore_errors=true`でも救えない）。`loadCSVFiles`（`duckdb.ts`）で各ファイルの末尾の制御バイトを事前に切り落として回避している
- 十字カーソル同期effect（`crosshairSourceId`/`crosshairTime`依存）は、メイン/非メインどちらの`series.setData()`effectよりも**後ろ**で宣言すること（宣言順だけでは解決しない場合あり、下記参照）
- `setCrosshairPosition`はsetData直後の同一コミット内で同期呼び出しすると、時刻が正しくても価格スケールの`firstValue`キャッシュが未確定でensureNotNullがnullを投げることがある。`requestAnimationFrame`で1フレーム後に呼ぶこと。メインパネルはcursorより先の未来足を`effectiveCursorRef`でクリップしてから`priceAtTime`に渡すこと（`candles`はcursor以降も含む全期間配列のため）
- 1画面表示中の非メイン3枠、3画面表示中の枠3は`width:0/height:0`で非表示のままマウントされ続ける（remount回避のため）。サイズ0のペインは価格スケールの`firstValue`が恒久的にnullなので、十字カーソル同期はこれら非表示パネルでスキップすること（どれだけ待っても解決しない・同期する意味もない）
- `timeToCoordinate`は時刻が実在かつ開示済み（setData済み）の足と完全一致しないとnullを返す。セッション帯のようにcursorより未来の時刻（NYの終了=翌7時等）を扱う描画は、`timeToX`に渡す前に開示済みの範囲へクランプすること。クランプ先は開示済み最後の足の**開始時刻ではなくその足の終わり**（`currentTime + timeframeSec`）にする（開始時刻でクランプすると、セッション開始のちょうどその足では帯幅が0になり1本分遅れて表示される）
- `App.tsx`のツールバー列を囲むフレックス行が`overflow:hidden`のため、`DrawToolbar.tsx`のポップアップは`position:absolute`だと画面下寄りで開いた時にmaxHeight+overflowYより先に祖先でクリップされ、スクロールバーごと消える。`position:fixed`＋`getBoundingClientRect`基準の座標計算で回避する
- lightweight-charts標準の最終値価格ライン（`priceLineVisible`のデフォルト、水平の破線＋現在値ラベル）とグリッド線（`layout.grid`）はSeries Primitivesの対象外でzOrder制御ができず、常に他の描画物より前面に出る。四角形・週区切り線がPrimitivesではなくDOM/canvasオーバーレイなのはこの制約を回避するため（詳細は主要機能の四角形描画の項）
- `showFullHistory`は廃止済み。全期間スクラバーの「全体」は常に`cursor+1`、`candles.length`（未来含む全データ）は使わない
- `setVisibleLogicalRange`へ渡す`from`/`to`は`LogicalRange`型変数に一度代入すると型エラーになる。その場のオブジェクトリテラルで直接渡すこと
- 追従アンカー（`followAnchorRef`）の`offset`はパン操作時に`range.to - lastIdx`で保存されるため、過去へ大きくスクロールした直後は大きな負数になり得る。`applyLatestViewRef`で`fullTotal + offset`が0以下ならspanが負になり`setVisibleLogicalRange`が`from > to`で例外を投げる——既定オフセットへフォールバックして防いでいる
- `resetTimeScale()`直後に`getVisibleLogicalRange()`を読んでも古い値が返る（非同期）。`requestAnimationFrame`を挟んでから読むこと
- 自前`<canvas>`（雲・トレンドライン・ブラシ）は`devicePixelRatio`倍で実解像度を確保し`ctx.setTransform`で描画すること（Retinaでのぼやけ・カクつき防止）
- ロウソク足と重なった描画物（雲の塗りつぶし・水平線・垂直線・四角形の枠線）を透明に抜く処理は`cutCandlesFromCanvas`（`CandleChart.tsx`）に共通化されている。実体（open〜close）はbarSpacing幅、ヒゲ（高値〜安値のうち実体を除く部分）は細い固定幅`WICK_CUTOUT_PX`で分けて抜く。lightweight-charts自体はヒゲの実描画幅を公開していないため`WICK_CUTOUT_PX`は近似値
- BBは`showBB`OFF中も裏で計算継続し`visible:false`で隠すだけ（再計算漏れ防止）
- `rawCsvText`は単一ファイル読込時のみセット（複数ファイルは大容量CSV二重読みを避けるため非対応）
- DuckDB-wasmはSharedArrayBuffer使用のためVite dev serverに`COOP/COEP`ヘッダ必須（`vite.config.ts`設定済み）
- `read_csv`に`all_varchar=true`/`ignore_errors=true`必須
- P&L計算はクオート通貨そのまま（円換算しない）
- JST変換は`queryCandles`の集計結果に事後適用（生の1分足には適用しない）。バケット境界自体はブローカー時間基準のまま残るため、カレンダー時刻を直接使う機能は実在の足と一致しない。区切り線は実際の足を境界に使う方式（`computeSeparatorBoundaries`）を踏襲すること
- チャートの時間軸目盛りは全シリーズ時刻の和集合。一目雲のずらしは秒数でなく**本数**で行うこと（`cloudDisplacedTime`）。図形の平行移動も秒数でなく足インデックス（`candleIndexAt`）で行うこと（週末の足抜け対策）
- `timeToCoordinate`/`priceToCoordinate`は`setData`/`setVisibleRange`/`applyOptions`直後は古い座標を返すことがある。同処理の最後に`requestAnimationFrame`で再同期すること
- 月境界マークは`tickMarkFormatter`を通らず`localization.dateFormat`を使う。有効トークンは`yyyy/yy/MMMM/MMM/MM/dd`のみ
- `tickMarkFormatter`の日付/時刻切替は「UTC 00:00かどうか」では判定しないこと。4H/1D/1W/1Mはブローカー時間バケット+JST表示ズレでUTC 00:00にほぼ乗らず、時刻だけが延々表示される。`timeframeSec>=14400`は常に日付表示にする
- lightweight-charts自身の目盛り（`tickMarkFormatter`）は間隔優先の自動配置のため、区切り線（週/月/年）の位置と必ずしも一致しない。区切り線には専用の日付ラベルをDOMで自前描画する（垂直線の日付ラベルと同じパターン、`syncWeekLines`）。土曜日の日境界は線のみでラベルは出さない（週末で取引が無く月曜の境界と近接し、ラベル同士がぶつかるため）。マウスカーソル位置の組み込み日付表示と自前ラベル（区切り線・垂直線とも）が接近した場合は自前ラベル側を隠す（共通ヘルパー`hideLabelNearCursor`、`subscribeCrosshairMove`で位置比較、しきい値28px）——DOMは常にcanvasより前面に出るため、隠さないとカーソル側の日付が読めなくなる
- 非メインの`nonMainVisible`再描画は`length===0`で早期returnしないこと（空でも`setData([])`を呼び画面を空にする）
- 自動再生は`requestAnimationFrame`（`setInterval`は高速再生時に描画ノイズが出る）
- ドラッグ系操作は開始時に`handleScroll`/`handleScale`を無効化し終了時に必ず再有効化すること
- 水平線・垂直線・TP/SL・draft価格は丸めない（表示側のみ`toFixed`）
- `onMouseDown`ヒット判定順序は「四角形→トレンドライン→ブラシ→テキスト→水平線」（水平線は全幅ヒットするため最後）
- DOMオーバーレイのz-indexは10〜13、雲の`<canvas>`はz-index:5
- ローソク足・背景・グリッドはlightweight-charts内部で同じ1枚のcanvasに一括描画される。DOM要素の負のz-indexで「ローソク足の下」に見せようとすると背景ごと隠れて何も見えなくなる（試すだけ無駄）
- 雲の塗りつぶしは`candles[0].time`より左側には描画しないようガードすること（範囲外の外挿防止）
- `jumpToTime`は通常モードだと過去日付ジャンプで`cursor`を戻さない（`Math.max(idx, oldCursor)`）。`{rewind:true}`指定時のみ`cursor`をそのまま`idx`にする（「巻き戻し」機能、約定済みの注文・決済は取り消さない）
- `centerOnTime`は時刻ベースでなく足インデックス（logical range）で計算すること（`getVisibleRange`/`setVisibleRange`は表示幅が狭い時に破綻する）
- `setVisibleRange()`（時刻ベース）は内部のtime→logical変換に失敗してクラッシュすることがある。全期間表示は`{from:0, to:candles.length}`のindexベースで直接指定すること
- `processOrderRange`は1本ずつ順に処理、同一バーでTP/SL両方ヒット時はSL優先。`jumpToTime()`は前進時のみ通過範囲を判定（後退は判定しない）
- `centerSignal`等のeffectはリプレイモードのcursor effectより後に置くこと（先に置くと`scrollToRealTime()`に上書きされる）
- CSV再読込で`lines`/`vlines`/`rects`/`closedTrades`/`positions`/`pendingOrders`は全リセット。時間軸切替では保持
- フォルダを開いた履歴はChrome/Edgeのみ対応（File System Access API）。Safari/Firefoxはフォールバックし履歴機能自体出ない
- 履歴の`FileSystemDirectoryHandle`は`startIn`の起点としてのみ使う（中身は読まない）。フルパスは取得不可能な仕様のため表示名はフォルダ名止まり
- 保存ビュー復元（`relativeViewToLogicalRange`）のspanは全期間本数でクランプするが、位置は`cursor`/`lastIdx`（revealされている本数）基準で右オフセットするため、リプレイ序盤でrevealが少ないと`from`が負（実データの無い過去側）にはみ出し、軸日付が実データとずれ小数の足が右端に押し込まれて見える。`to`固定・`from`を0未満にクランプして回避（`CandleChart.tsx`のメイン/非メイン両方の分岐）
- 非メイン（4画面の他3枠）はデータセット変更時に1回フィットするだけで以降は自動で進まない設計だったため、「最新足に固定」の継続追従effect（`followLatest`）をfollowLatestトグルに関わらず非メインは常時有効にした（メインは従来通りトグル依存）。この継続追従effectは非メインのsetData/初回フィットeffectより**必ず後ろ**で宣言すること——先に置くと、データセット変更直後にまだ`series.setData()`前（＝可視範囲がデフォルトの空状態）のタイミングで`followAnchorRef`を誤って捕捉してしまい、以降ずっとそのパネルにロウソク足が表示されなくなる
- フロートパネルの位置クランプは`chart.priceScale('right').width()`/`chart.timeScale().height()`の実測値をstore経由で共有
- 非メインの形成中バケット探索は`candles[cursor].time`（メイン現在足の開始時刻）ではなく`nonMainCursorEnd`（終了時刻）を基準にすること。非メインがメインより細かい時間足の場合、開始時刻基準だとclosed側より過去のバケットを見つけてしまい、lightweight-charts側の`setData`が「data must be asc ordered by time」で丸ごとクラッシュする
- `nonMainCursorEnd`は`candles[cursor].time + mainTimeframeSec`で都度計算し直さず、store側の`mainRevealedUntil`をそのまま使うこと。メインが形成中バケットを指している時に計算し直すと、新しい時間足のmainTimeframeSecを使うことになり実際の開示境界より大きくずれる——直前までメインだったパネルが降格した瞬間、開示状況は何も変わっていないのに余分な未来の足まで表示され無関係な再描画が起きる不具合になる
- `setTimeframe`のカーソル復元は`mainRevealedUntil`（＝切替直前の「今」の時刻+timeframeSec。advance/stepBack/jumpToTime/advanceToEndでのみ更新し、時間足の切替では据え置く）を基準にする。この値が指すバケットが新しい時間足で見てまだ確定していなければ、`finestSourceCandles`/`finestSourceCursor`（＝実際にカーソルを動かした時点のメインの確定済み足。setTimeframeでは更新しない）から`buildPartialCandle`で部分集計した「形成中」足に差し替えてcursorをそこに置く（確定済みバケットへ丸めない）——これにより「メイン切替は見た目だけの変更で状態は変えない」「切り替えて何もせず戻せば元通り」が成り立つ。`buildPartialCandle`/`findBucketIndexContaining`は`src/lib/partialCandle.ts`に集約し、非メインの形成中足描画（`CandleChart.tsx`の`nonMainVisible`）とメイン切替の両方で共有する。部分集計の元データにグローバルな`candles`（切替直後は新しい・粗いことがある）を使うと、他の非メインパネル（メインより細かい時間足）が形成中足を再集計できず1つ前の確定済みバケットまで戻って見える不具合になるため、必ず`finestSourceCandles`を使うこと
- ヘッダー「日付：」の表示は`candles[cursor].time`（新しい時間足のバケット開始時刻、例: 1Dなら07:00始まり）ではなく`mainDisplayTime`（実際にカーソルを動かした時点の生の時刻。+timeframeSecしない・切替をまたいで据え置く）を使うこと。`candles[cursor].time`を使うと切替のたびに新しい時間足のバケット境界に丸まって見え、「切り替えても表示時刻は変わらないでほしい」という要望に反する
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
