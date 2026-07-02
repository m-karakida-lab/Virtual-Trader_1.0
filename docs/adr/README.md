# ADR (Architecture Decision Record)

## 書く基準

以下のいずれかに当てはまる判断だけ書く:

- 1 時間以上悩んだ
- 反対の選択肢にも合理性があった
- 後で「なぜこうした？」と自分が忘れそう
- 同じ罠を次プロジェクトでも踏みそう

**悩まなかった決定は書かない**。書くほど古くなる。書かなかった分は git log と CURRENT.md で補える。

## 命名

`NNN-short-kebab-title.md` の形式。番号は連番（欠番 OK、リネーム禁止）。

例:
- `001-undo-store-separation.md`
- `002-ipc-error-shape.md`
- `003-z-index-layering.md`

## テンプレ

`000-template.md` をコピーして使う。

## 1 ファイルの長さ

10〜30 行が目安。長文の議事録は書かない。「状況 / 決定 / 理由 / 影響」の 4 ブロックで足りる。
