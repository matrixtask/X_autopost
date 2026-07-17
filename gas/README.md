# セットアップガイド（Google Apps Script版）

所要時間の目安: 30〜45分。上から順に進めてください。

## 0. 必要なもの

| サービス | 用途 | 必須 |
| --- | --- | --- |
| Googleアカウント | GAS + スプレッドシート（DB） | ✅ |
| Anthropic APIキー | 質問生成・下書き生成・採点 | ✅ |
| Slackワークスペース | インタビュー対話・通知 | ✅ |
| X Developer（Free枠でOK） | 自動投稿 | 投稿時のみ |
| Notionインテグレーション | ストックのデータベース閲覧 | 任意 |

## 1. スプレッドシートとGASプロジェクト

1. 新しいGoogleスプレッドシートを作成し、URLの `/d/` と `/edit` の間のIDを控える
2. [script.google.com](https://script.google.com) で新規プロジェクトを作成
3. `gas/src/` の各ファイルをプロジェクトに追加する
   - `*.js` はスクリプトファイル（GAS上では `.gs` になる）、`Index.html` はHTMLファイルとして作成
   - claspを使う場合: `npm i -g @google/clasp && clasp login`、`.clasp.json.example` を `.clasp.json` にコピーしてscriptIdを記入し、`gas/` ディレクトリで `clasp push`
4. プロジェクトの設定 > スクリプト プロパティに以下を登録:

| プロパティ | 値 |
| --- | --- |
| `SPREADSHEET_ID` | 手順1のID |
| `ANTHROPIC_API_KEY` | AnthropicのAPIキー |
| `ADMIN_TOKEN` | 長いランダム文字列（Webアプリの認証用） |
| `DRY_RUN` | `true`（最初は必ずtrueのまま） |

5. GASエディタで `setupSpreadsheet` を選んで実行（初回は権限承認ダイアログが出る）
   → シート（Stock / Interviews / Themes / Voice / Log）とテーマ初期データが作られる

## 2. 文体の登録（いちばん大事）

スプレッドシートの **Voice** シートのA列に、**自分が実際に書いたポストや文章を20〜50本**貼ってください。これが文体再現の材料（few-shot）と採点基準になります。多いほど「自分っぽく」なります。B列は任意のメモです。

**Themes** シートは自由に編集できます。`category` は `evergreen`（定番）/ `news`（時事）/ `neta`（ネタ）の3種類、`weight` が大きいほど選ばれやすくなります。

## 3. Webアプリのデプロイ（スマホ確認UI + Slack受け口）

1. GASエディタ > デプロイ > 新しいデプロイ > 種類: **ウェブアプリ**
   - 実行ユーザー: **自分** / アクセスできるユーザー: **全員**
2. 発行されたURL（`https://script.google.com/macros/s/.../exec`）をスクリプトプロパティ `WEBAPP_URL` に保存
3. スマホで `WEBAPP_URL?token=ADMIN_TOKEN` を開き、ホーム画面に追加すればモバイルアプリとして使えます

> コードを更新したら「デプロイを管理 > 編集 > 新バージョン」で反映されます（URLは変わりません）。

## 4. Slackアプリ

1. [api.slack.com/apps](https://api.slack.com/apps) > Create New App > From scratch
2. **OAuth & Permissions** > Bot Token Scopes に `chat:write` と `channels:history`（プライベートチャンネルなら `groups:history`）を追加し、ワークスペースにインストール
3. Bot User OAuth Token（`xoxb-...`）をスクリプトプロパティ `SLACK_BOT_TOKEN` に保存
4. インタビュー用チャンネルを作成し、`/invite @ボット名` で招待。チャンネルIDをプロパティ `SLACK_CHANNEL_ID` に保存
5. **Event Subscriptions** を有効化:
   - Request URL に手順3のWebアプリURLを入力（Verifiedと出ればOK）
   - Subscribe to bot events に `message.channels`（プライベートなら `message.groups`）を追加して保存

> **セキュリティ注**: GASはリクエストヘッダを読めないためSlack署名検証ができません。代わりにチャンネルID一致チェックとevent_id重複排除で防御しています。インタビューチャンネルには本人だけを入れてください。

## 5. X API（投稿を有効にするとき）

1. [developer.x.com](https://developer.x.com) でアプリを作成（Free枠で月500件まで投稿可）
2. User authentication settings で **Read and Write** を有効化
3. Keys and tokens から4つの値をスクリプトプロパティに保存:
   `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`
   （Access Tokenは権限変更後に**再生成**したものを使うこと）
4. 動作確認が済むまで `DRY_RUN` は `true` のまま

## 6. Notion同期（任意）

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) でインテグレーションを作成し、シークレットを `NOTION_TOKEN` に保存
2. Notionでデータベースを作成し、以下のプロパティを用意:
   - `Name`（タイトル）/ `Status`（セレクト）/ `Category`（セレクト）/ `Score`（数値）/ `Scheduled`（日付）/ `Posted`（日付）/ `Body`（テキスト）
3. データベースをインテグレーションに共有（… > コネクト）し、データベースIDを `NOTION_DATABASE_ID` に保存

## 7. トリガー登録（ルーティンの起動）

GASエディタで `installTriggers` を実行すると以下が登録されます:

| タイミング | 関数 | 内容 |
| --- | --- | --- |
| 毎朝8時台 | `startDailyInterview` | テーマ選定 → Slackにインタビュー |
| 毎晩21時台 | `nightlyGateAndSchedule` | 採点 → 予約割当 → Slack通知 |
| 毎時 | `postTick` | 予約時刻を過ぎたものを投稿 |
| 毎週月曜9時台 | `weeklyDigest` | ストック残量・先週の実績を通知 |

## 8. 動作確認 → 本番切り替え

1. `startDailyInterview` を手動実行 → Slackに質問が来る → スレッドで返信 → 下書きがStockシートに入ることを確認
2. `nightlyGateAndSchedule` を手動実行 → 採点・予約とSlack通知を確認
3. `postTick` を手動実行 → `[DRY RUN]` 通知で内容を確認
4. 問題なければ:
   - `DRY_RUN` を `false` に（実投稿が始まる）
   - 品質ゲートを信用できるようになったら `AUTO_APPROVE` を `true` に（承認タップも不要になる）

## 調整できるプロパティ

| プロパティ | 既定値 | 意味 |
| --- | --- | --- |
| `QUALITY_THRESHOLD` | `75` | 品質ゲートの合格点（上げるほど厳選） |
| `SLOT_TIMES` | `08:00,12:30,19:30` | 1日の予約枠 |
| `MAX_POSTS_PER_DAY` | `3` | 1日の最大投稿数 |
| `INTERVIEW_QUESTIONS` | `4` | 毎朝の質問数 |
| `CLAUDE_MODEL` | `claude-sonnet-5` | 生成・採点に使うモデル |

## トラブルシューティング

- **Slackに質問が来ない**: Logシートと GASの「実行数」画面でエラーを確認。`SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` とボットのチャンネル招待を確認
- **スレッドに返信しても反応がない**: Event SubscriptionsのRequest URLがVerifiedか、`message.channels` を購読しているか、Webアプリのデプロイが最新かを確認
- **投稿が401/403で失敗**: Xのアクセストークンを Read and Write 権限にしてから再生成したか確認
- **文体がAIっぽい**: Voiceシートのサンプルを増やす。`QUALITY_THRESHOLD` を上げるのも有効
