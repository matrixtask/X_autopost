# 応答モデルをOpenAIへ切り替える

2026-09-10の依頼により、本人向けの生成処理をOpenAI Responses APIへ切り替えた。
ChatGPTの画面を操作する仕組みではなく、GASからAPIを呼び出す。

| 用途 | 既定プロバイダ | モデル・設定 |
| --- | --- | --- |
| 初回質問・受け答え・追問・次問調整・聞き返し | OpenAI | `OPENAI_MODEL=gpt-6-astra` / effort `low` |
| 画像説明・下書きを補うヒント | OpenAI | 同上 |
| 下書き・リライト | OpenAI | `OPENAI_MODEL_GENERATE`（未設定なら `OPENAI_MODEL`）/ effort `medium` |
| 採点・遡及採点・採点再現性確認 | Claude | 既存 `CLAUDE_MODEL_SCORE` を維持 |
| テーマの分類・分析・メンテナンス | Claude | 既存 `CLAUDE_MODEL` を維持 |

生成先だけを変え、Voiceや本人メモ、質問の品質ルール、出典検証は引き継ぐ。
モデル変更による品質向上は未検証。既存スコアとの比較のため採点は切り替えない。

## 設定と反映

1. GASの「プロジェクトの設定」→「スクリプト プロパティ」に `OPENAI_API_KEY` を登録する。
   キーはコード・スプレッドシート・Slack・GitHubへ書かない。API側で対象モデルを利用できる必要がある。
2. `RESPONSE_PROVIDER=openai`、`OPENAI_MODEL=gpt-6-astra` を設定する。どちらも未設定時の既定値と同じ。
   採点と裏方分析用の `ANTHROPIC_API_KEY` は残す。
3. Ubuntuで反映する:

   ```bash
   cd ~/X_autopost && git pull origin main && cd gas && ./deploy.sh
   ```

   B（Slack）のバージョン付きデプロイも更新する。`.deployment-id-slack` が登録されていれば
   `deploy.sh` が更新する。`clasp push` だけではSlackからの受信処理は切り替わらない。
4. GASエディタで **`OpenAI.gs` を開き、`testOpenAIConnection` を選んで実行**する。
   モデル名と応答が実行ログへ出る。OpenAI APIを1回呼び、Logへ診断記録を残す。
   X投稿・Slack送信・Stock/Interviewsの変更は行わない。
5. 次のインタビューで会話と生成を確認する。Logの `openai_response` にモデル・用途・トークン数が残る。

この変更自体は列追加なし。PR #52の補足機能をまだ反映していなければ、`Sheets.gs` の
`setupSpreadsheet` も1回実行する。

## エラーと切り戻し

- キー未設定、認証・権限・モデル指定のエラー、利用枠不足は再試行せず設定を案内する。
- 拒否・content filterは部分出力があっても採用せず、他モデルへの自動切替もしない。
- 出力トークン不足は既存のJSON再試行・部分救出を使う。通常の会話応答は1回で打ち切り、
  失敗時は原文を残して予定質問で進む。部分救出は完成したJSON要素のみ。
- 429等の一時エラーは既存JSONラッパーの上限内でのみ再試行する。
- APIエラー本文やAPIキーはLogへ出さず、HTTPステータスとエラーコードを記録する。
- `store:false` で応答保存を無効にする。送信内容の取り扱い全体をゼロ保持と保証する設定ではない。
- `RESPONSE_PROVIDER=claude` で旧生成経路へ戻せる。既存のClaudeモデル設定を再利用する。

## 実装と検証

新規ファイルは `gas/src/OpenAI.js` → GASの **`OpenAI.gs`**。
`responseProviderFor` / `openAIModelFor` / `openAIError` / `openAIInput` / `openAIMessage` は内部関数。
手動実行するのは引数なしの `testOpenAIConnection` のみ。
既存 `askClaude*` の関数名と呼び出し形式を維持し、`purpose: interview|generate` をルーティングする。
`purpose: score` と用途未指定はClaudeに残す。

`npm test` 68件合格（既存56+新規12）。用途別ルーティング、画像形式、拒否・キー未設定・
HTTPエラー・途中切れ・JSON部分救出・秘密を出さないログを模擬APIで検証。
キーとGAS接続設定のない開発環境のため、実API通信・GASデプロイ・応答時間・文体の品質は未検証。

仕様確認元（2026-09-10取得）:

- [GPT-6 Astra移行ガイド](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart)：モデルID、reasoning.effort、非対応パラメータ。
- [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)：入力、出力ブロック、トークン上限、不完全応答、保存設定。
