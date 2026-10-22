# 全用途をOpenAIへ統一する

2026-10-22の依頼により、本番GASの質問・会話・画像説明・生成・採点・分析をすべてOpenAI Responses APIへ統一した。ChatGPT画面の操作ではなく、既存のOpenAI APIキーを使う。

従来は採点・分析だけClaudeだった。現在は `RESPONSE_PROVIDER=claude`、`CLAUDE_*`、`ANTHROPIC_API_KEY` が残っていても参照しない。Anthropicへの送信処理とプロバイダ間fallbackはなく、設定の削除・キーの変更は不要。

## 用途別モデルと推論量

| 用途 | モデルの設定 | 推論量の設定・既定 |
| --- | --- | --- |
| 質問・会話・聞き返し・画像説明 | `OPENAI_MODEL`（未設定は `gpt-6-luna`） | `OPENAI_EFFORT_INTERVIEW=low` |
| 下書き・リライト・生成前の会議と編集 | `OPENAI_MODEL_GENERATE`（未設定は基本モデル） | `OPENAI_EFFORT_GENERATE=medium` |
| 採点・編集審査・遡及採点 | `OPENAI_MODEL_SCORE`（未設定は基本モデル） | `OPENAI_EFFORT_SCORE=medium` |
| テーマ分類・分析・用途未指定の処理 | `OPENAI_MODEL_ANALYSIS`（未設定は基本モデル） | `OPENAI_EFFORT_ANALYSIS=medium` |

既存のOpenAIモデル指定は引き継ぐ。今回、採点・分析用のモデル指定を新設した。未設定なら基本モデルへ継承するため、既存設定がLunaなら全用途Lunaになる。モデルや推論量を変えた効果は別途検証する。

Voice、本人メモ、3人格→ミア→リナの編集、原文引用・出典検証、時間予算、本人承認は維持する。保存済みの回答・下書き・過去の採点は一括改稿・再採点しない。

## 接続確認と反映

1. 既存の `OPENAI_API_KEY` を使用する。キーはコード・シート・Slack・GitHubへ書かない。Anthropicのキーは不要だが、この変更で削除はしない。
2. UbuntuでコードとA/B両方を反映する。

   ```bash
   cd ~/X_autopost && git pull origin main && cd gas && ./deploy.sh
   ```

   `clasp push` だけでは、Slack受け口のバージョン付きデプロイは更新されない。モデル切り替えにシート初期化やトリガー再登録は不要。
3. GASエディタの **OpenAI.gs** を開き、次の関数を実行すると、実際のモデル名とOK応答を確認できる。各1回のAPI呼び出しでLogに診断を残す。投稿、Slack送信、Stock/Interviewsの変更はしない。
   - `testOpenAIConnection`：質問・会話
   - `testOpenAIGenerationConnection`：下書き生成
   - `testOpenAIScoringConnection`：採点
   - `testOpenAIAnalysisConnection`：用途未指定の分析
4. 次の処理から全用途OpenAIになる。進行中のインタビューも、次のモデル呼び出しから切り替わる。Logの `openai_response` にモデル・用途・推論量・トークン数が残る。

旧 **Claude.gs** の `testClaudeScoringConnection` は互換口として残すが、OpenAIの採点接続確認を実行し、結果にもOpenAIと表示する。`askClaude*`、`claudeMessage` という旧関数名もOpenAIへ接続するため、ファイル名・関数名からプロバイダを判断しない。

## 採点履歴とエラー

新規の編集審査は `openai/<model>/<effort>` をscorerに保存する。Claudeで保存済みの履歴はそのまま保持し、成果検証では採点官別に分ける。審査中にモデル・推論量が変更された場合は、異なる採点官の名前で結果を保存せず再評価待ちにする。旧モデルとの点数差だけで品質向上とは判断しない。

キー未設定、認証・権限・モデル指定・利用枠のエラーでは、Claudeへ戻さない。一時エラーだけ既存JSONラッパーの上限内で再試行する。拒否・content filterは部分出力があっても不採用。出力トークン不足は既存の出力枠拡大・JSON部分救出を使うが、投稿構成の厳密な検証は維持する。

`store:false` は応答保存を無効にする設定で、送信内容全体のゼロ保持を保証するものではない。APIエラー本文・キー・JSONパース失敗時の回答本文をログへ丸ごと出さない。共通の再試行ログは `llm_retry`、部分救出は `llm_json_salvaged`。

旧プロバイダ設定でClaudeへ切り戻す機能はない。障害時は勝手に別プロバイダへ送らず、保存済み回答を維持して停止する。コードのロールバックはGit履歴と既存のデプロイ版を使う。

## 検証範囲

全用途のルーティング、旧設定とAnthropicキーなしでの動作、用途別モデル・推論量、画像変換、拒否・HTTPエラー・打ち切り・JSON救出、採点官記録と審査中の設定変更を模擬APIで検証する。テスト・デプロイだけで、実モデルの採点品質やインプレッション向上を証明しない。

公式仕様（2026-10-22確認）: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Responses API](https://developers.openai.com/api/docs/guides/reasoning)。LunaのResponses APIとlow/medium推論量を確認し、既存のモデル選択を維持した。
