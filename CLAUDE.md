# X Autopost

GASで動くX（Twitter）の自動投稿システム。`gas/src/*.js` が本体で、clasp で GAS の `*.gs` として反映される。

## ユーザーへの説明ルール

**新しい関数を追加したら、それがGASエディタ上のどのファイル（`◯◯.gs`）に入るかを必ず書く。**

GASエディタの関数プルダウンは、開いているファイルの関数しか表示しない。ファイル名が分からないと実行できないため、「`Themes.gs` を開いてからプルダウンで選ぶ」まで案内する。リポジトリ上のパス（`gas/src/Themes.js:86`）も併記する。

対応関係は `gas/src/Foo.js` → GASエディタの `Foo.gs`。

## デプロイは2本ある

| デプロイ | アクセス範囲 | 用途 | URLの保管場所 |
| --- | --- | --- | --- |
| A（管理UI） | 自社ドメイン内のユーザー | 人間が開くWebアプリ | スクリプトプロパティ `WEBAPP_URL` |
| B（Slack） | 全員 | Slack Event Subscriptions専用 | SlackアプリのRequest URL |

見分けるときは「デプロイを管理」の `アクセスできるユーザー` 列を見る。`clasp push` だけではWebアプリに反映されないので、Slackの受け口を変えたときは**Bのデプロイ更新まで案内する**こと。`./deploy.sh` はIDを登録しておけば両方を更新する。

## ファイルの役割

| ファイル | 中身 |
| --- | --- |
| `Config.js` | 定数、スクリプトプロパティ、採点軸(AXES)、相関ベクトルと内積スコア |
| `Pure.js` | GAS非依存の純粋関数。`test/gas-pure.test.js` が vm で読み込んで検証する |
| `Sheets.js` | スプレッドシート操作。`SHEET_HEADERS` が列定義の正 |
| `Claude.js` | Claude API クライアント |
| `Interview.js` | 朝のインタビュー、質問生成、Slack返信の処理 |
| `Drafts.js` | 回答からポスト下書きを生成 |
| `Quality.js` | 品質ゲート、自己批判リライト、遡及採点 |
| `Themes.js` | テーマ選定、テーマ重みの学習、手動投稿からの逆算 |
| `Metrics.js` | メトリクス収集、フォロワー記録、軸別相関分析 |
| `Scheduler.js` / `XApi.js` / `Slack.js` / `Notion.js` / `News.js` / `Voice.js` / `Memory.js` / `Rewrite.js` / `Triggers.js` / `WebApp.js` / `Index.html` | 各機能 |

## 実装上の注意

- **`updateStockById` は1件ごとにシート全体を読み直す。** 数十件を超える一括更新では使わず、`readTable` が返す `_row` と `setColumnByRows` で直接書く
- **`appendRow` は1行あたり100ms前後かかる。** 数百行なら `appendRowsObj`（`setValues` で一括）
- **GASの実行時間上限は6分。** 長い処理は4分で打ち切り、`after()` のワンショットトリガーで自分を再実行する。二重実行は `LockService` で弾く
- **LLMに軸スコアを返させるときは配列形式。** 17個の軸名をキーで書かせると1件250トークン近くかかり、`max_tokens` の途中で切れる
- **列を増やしたら `SHEET_HEADERS` に追記する。** `ensureHeaders` が末尾に足す
