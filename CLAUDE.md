# X Autopost

GASで動くX（Twitter）の自動投稿システム。`gas/src/*.js` が本体で、clasp で GAS の `*.gs` として反映される。

## PRは確認なしでマージしてよい

このリポジトリでは、自分で作ったPRを都度確認を取らずにsquashマージしてよい（2026-08-04にユーザーが許可）。マージ後は `main` をローカルに同期し、反映に必要な手順（`clasp push` / `./deploy.sh` / `setupSpreadsheet` など）を案内する。

ただし次の場合は先に相談する。

- 設計上の分岐があり、選んだ方向で結果が大きく変わるとき
- 既存データを壊しうる変更（列の削除、行の削除、シートの作り直し）
- 挙動を推測でしか直せておらず、間違っていると症状が悪化しうるとき

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
| `Claude.js` | 共通の互換呼び出し口、Claude API、JSON再試行 |
| `OpenAI.js` | 用途別ルーティングとOpenAI Responses API。質問・会話・生成は既定OpenAI、採点はClaude |
| `Interview.js` | 朝のインタビュー、質問生成、Slack返信の処理 |
| `Drafts.js` | 回答からポスト下書きを生成 |
| `Quality.js` | 品質ゲート、自己批判リライト、遡及採点 |
| `Themes.js` | テーマ選定、テーマ重みの学習、手動投稿からの逆算 |
| `Metrics.js` | メトリクス収集、フォロワー記録、軸別相関分析 |
| `Scheduler.js` / `XApi.js` / `Slack.js` / `Notion.js` / `News.js` / `Voice.js` / `Memory.js` / `Rewrite.js` / `Triggers.js` / `WebApp.js` / `Index.html` | 各機能 |

## 実装上の注意

- **2026-09-12 長文回答の編集:** `docs/long-answer-editing.md`。長い回答は `PostComposition.js` のリナが独立した分割/長文1本/短文1本を選ぶ。生成前の3者会議・ミア、生成後の3者＋ミア審査、人の承認を維持。`post_format` を無視して280重みへ切らない。新編集案を短文専用リライトへ送らない。長文利用可能はユーザー確認済み、`X_LONG_POSTS_ENABLED` 既定true。

- **2026-09-11 生成前の編集会議:** `docs/editorial-council.md` を参照。`EditorialCouncil.js` の3人格会議→ミア内省を経てから初回質問・会話応答・インタビュー投稿を生成する。核の引用とqiは検証し、本文に残す。機械切断で140字へ合わせない。原文回答を代作しない。共通実行予算をClaude.jsのAPI入口でも確認する。

- **2026-09-10 採点・テーマ改訂:** 現行方針は `docs/outcome-editorial-quality.md`。`QUALITY_MODE=outcome` が既定。新5軸は参考値、資料照合を通った案も人の承認が必要。点数による自動リライトは停止。旧17軸・アンカーは legacy 経路に保存。新旧の尺度を混ぜない。
- `Editorial.js` は本人・テトラ中心のテーマと禁止された話題の除外、`OutcomeQuality.js` は新採点・資料照合・投稿前採点の成果検証。新テーマは20件を自動追加し、古いテーマや停止行は消さない。堀江さんの話を日次・週次で復活させない。

- 質問・受け答えの方針と回帰条件は `docs/interview-quality.md`。補足は1セッション1回まで、短答を低品質扱いしない。下書きとリライトの一次資料は `interviewAnswerText` を共有する。`no_material` は生成失敗ではない

- **`updateStockById` は1件ごとにシート全体を読み直す。** 数十件を超える一括更新では使わず、`readTable` が返す `_row` と `setColumnByRows` で直接書く
- **`appendRow` は1行あたり100ms前後かかる。** 数百行なら `appendRowsObj`（`setValues` で一括）
- **GASの実行時間上限は6分。** 長い処理は4分で打ち切り、`after()` のワンショットトリガーで自分を再実行する。二重実行は `LockService` で弾く
- **LLMに軸スコアを返させるときは配列形式。** 17個の軸名をキーで書かせると1件250トークン近くかかり、`max_tokens` の途中で切れる
- **列を増やしたら `SHEET_HEADERS` に追記する。** `ensureHeaders` が末尾に足す
