# 応答モデルをOpenAIへ切り替える

2026-09-10の依頼により、本人向けの生成処理をOpenAI Responses APIへ切り替えた。
ChatGPTの画面を操作する仕組みではなく、GASからAPIを呼び出す。

2026-09-26: ユーザー指定で質問・会話・投稿生成の既定モデルを `gpt-6-luna` へ変更。質問/会話のeffortはlow、投稿生成はmediumを維持。生成前の3人格会議とミア、保存前編集も用途に応じてLunaを使う。採点・裏方分析はClaude Opus 5.5へ変更（採点官の変更はユーザー了承済み）。
既にスクリプトプロパティにモデル名がある場合は既定値より優先されるため、`OPENAI_MODEL` と `OPENAI_MODEL_GENERATE` の両方を `gpt-6-luna` に更新する。`RESPONSE_PROVIDER` は `openai`。キーは変更不要。
Claude側の既存値も既定値より優先される。採点・分析のOpus 5.5は `CLAUDE_MODEL=claude-opus-5-5` と `CLAUDE_MODEL_SCORE=claude-opus-5-5` を設定する。スクリプトプロパティに `CLAUDE_MODEL_GENERATE` が既にあり、Claudeの下書き経路もOpusにする場合はその値も更新する（現在の `RESPONSE_PROVIDER=openai` では投稿生成に使わない）。キーとプロバイダ設定は変更不要。
`CLAUDE_FALLBACKS=auto` は拒否時にAnthropic推奨の別モデルへサーバー側で引き継ぐことがある。採点官をOpusに固定したい場合は `CLAUDE_FALLBACKS=off` にする。Logに `claude_fallback` が出た採点は通常のOpus採点と分けて解釈する。
既存コードにもこの3プロパティはあるため、モデルの切り替え自体はプロパティ保存で次の実行から有効になる。

公式仕様: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) はResponses APIとreasoning.effortのlow/mediumをサポート（2026-09-26確認）。Luna変更時にローカルの模擬APIテスト156件通過。Opus用の回帰テストを追加したが未実行。実アカウントのモデル利用権限・出力品質・本番切り替えは未確認。

| 用途 | 既定プロバイダ | モデル・設定 |
| --- | --- | --- |
| 初回質問・受け答え・追問・次問調整・聞き返し | OpenAI | `OPENAI_MODEL=gpt-6-luna` / effort `low` |
| 画像説明・下書きを補うヒント | OpenAI | 同上 |
| 下書き・リライト | OpenAI | `OPENAI_MODEL_GENERATE`（未設定なら `OPENAI_MODEL`）/ effort `medium` |
| 採点・遡及採点・採点再現性確認 | Claude | `CLAUDE_MODEL_SCORE=claude-opus-5-5` |
| テーマの分類・分析・メンテナンス | Claude | `CLAUDE_MODEL=claude-opus-5-5` |

生成先だけを変え、Voiceや本人メモ、質問の品質ルール、出典検証は引き継ぐ。
モデル変更による品質向上は未検証。既存の点数・審査履歴は書き換えず、切り替え後の採点に適用する。旧採点官との点数差だけを品質向上と解釈しない。

## 設定と反映

1. GASの「プロジェクトの設定」→「スクリプト プロパティ」に `OPENAI_API_KEY` を登録する。
   キーはコード・スプレッドシート・Slack・GitHubへ書かない。API側で対象モデルを利用できる必要がある。
2. `RESPONSE_PROVIDER=openai`、`OPENAI_MODEL=gpt-6-luna`、`OPENAI_MODEL_GENERATE=gpt-6-luna`、`CLAUDE_MODEL=claude-opus-5-5`、`CLAUDE_MODEL_SCORE=claude-opus-5-5` を設定する。
   採点と裏方分析用の `ANTHROPIC_API_KEY` は残す。
3. Ubuntuで反映する:

   ```bash
   cd ~/X_autopost && git pull origin main && cd gas && ./deploy.sh
   ```

   B（Slack）のバージョン付きデプロイも更新する。`.deployment-id-slack` が登録されていれば
   `deploy.sh` が更新する。`clasp push` だけではSlackからの受信処理は切り替わらない。
4. GASエディタで **`OpenAI.gs`** の `testOpenAIConnection` / `testOpenAIGenerationConnection` と **`Claude.gs`** の `testClaudeScoringConnection` を実行し、選択されたモデル名を確認する。各関数はAPIを1回呼ぶ。
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
手動接続確認は引数なしの `testOpenAIConnection` / `testOpenAIGenerationConnection`。
既存 `askClaude*` の関数名と呼び出し形式を維持し、`purpose: interview|generate` をルーティングする。
`purpose: score` と用途未指定はClaudeに残す。

`npm test` 68件合格（既存56+新規12）。用途別ルーティング、画像形式、拒否・キー未設定・
HTTPエラー・途中切れ・JSON部分救出・秘密を出さないログを模擬APIで検証。
キーとGAS接続設定のない開発環境のため、実API通信・GASデプロイ・応答時間・文体の品質は未検証。

仕様確認元（2026-09-10取得）:

- [GPT-6 Astra移行ガイド](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart)：モデルID、reasoning.effort、非対応パラメータ。
- [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)：入力、出力ブロック、トークン上限、不完全応答、保存設定。
#### 本番スクリプトプロパティ

| プロパティ | 値 |
| --- | --- |
| `RESPONSE_PROVIDER` | `openai` |
| `OPENAI_MODEL` | `gpt-6-luna` |
| `OPENAI_MODEL_GENERATE` | `gpt-6-luna` |
| `CLAUDE_MODEL` | `claude-opus-5-5` |
| `CLAUDE_MODEL_SCORE` | `claude-opus-5-5` |
| `CLAUDE_FALLBACKS` | Opusへ固定するなら `off`（現設定 `auto` は拒否時に別モデルへ引き継ぐ場合あり） |

- `CLAUDE_MODEL_GENERATE` はClaudeで下書きする時だけ使う。いまのOpenAI生成経路では参照しない。Anthropic/OpenAIの各APIキーは変更不要。
- Anthropic公式モデルIDは `claude-opus-5-5`。Messages APIのthinking blockは既存コードがtypeで選別して本文から除外する。Opus 5.5はadaptive thinkingが常時有効、既定effortはmedium。fallbacksは拒否時に推奨先へ移るので、固定採点には `off` を選べる。
- 既存の採点値、説明、判定履歴を書き換える再採点は実行しない。今後の採点だけモデルが変わる。点数水準の変更は品質の変化と混同しないよう、旧モデルとOpusのサンプルを同じ下書きで比較するまで慎重に判断する。

【安全な接続確認】GASエディタの **OpenAI.gs** で `testOpenAIConnection` と `testOpenAIGenerationConnection`、**Claude.gs** で `testClaudeScoringConnection` をそれぞれ実行する。OKだけを求めるAPI呼び出しで、採点データ・Stock・投稿・Slackを変更しない。結果に出るモデル名を確認する。

【反映】設定保存だけで次の実行からモデル選択が変わる。接続テスト用関数と既定値のコードも更新するため、Ubuntuから `cd ~/X_autopost && git pull origin main && cd gas && ./deploy.sh` を実行し、デプロイA/B両方を更新する。

公式仕様: [Claude Opus 5.5](https://platform.claude.com/docs/en/models/overview) / [Opus 5.5の変更と互換性](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5)
