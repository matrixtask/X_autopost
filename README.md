# X Autopost for 中井佑

中井佑さんの人となり、ビジネスの考え方、空飛ぶクルマ事業の進捗が伝わるX投稿を、Ubuntu上の常時稼働Node.jsとAndroid承認アプリで運用するためのスターターです。

参考にした運用思想は、AIが1週間分の投稿案を作り、人間は週初に承認だけ行い、承認済み投稿だけを自動投稿する分業です。投稿の「判断」と「実行」を分離し、作業はエージェントへ、意思は本人に残します。

## 全体像

1. `server/src/generate-week.js` が翌週7日分、毎日7時・12時・19時の投稿ドラフトを作ります。
2. Androidアプリが自宅Ubuntu上のAPIへ接続し、ドラフトの承認・却下・本文修正を行います。
3. Ubuntu側のブラウザUI（`http://<UbuntuのIP>:8787/`）で、ドラフト承認とアナリティクスを確認します。
4. `server/src/tick.js` が毎時実行され、予定時刻を過ぎた承認済み投稿をX APIへ投稿します。
5. `DRY_RUN=true` の間はXへ投稿せず、動作検証用の投稿結果だけを保存します。

## 投稿方針

- 一般的に反応されやすい「問い」「学び」「失敗談」「原理原則」を混ぜます。
- 誇大な進捗表現を避け、「今日も安全側に一歩進んだか」のような等身大の事業進捗を重視します。
- 空飛ぶクルマを、技術発表ではなく移動体験・地域実装・運航設計のビジネスとして語ります。
- 投稿は260字以内を目安にし、必要に応じて `#空飛ぶクルマ` と `#事業開発` を付けます。

## Ubuntuセットアップ

```bash
git clone <this-repo> /opt/X_autopost
cd /opt/X_autopost
cp .env.example .env
npm test
npm run generate:week
ADMIN_TOKEN=<your-token> npm start
```

systemdで常時運用する場合は、`server/systemd/*.service` と `server/systemd/*.timer` を `/etc/systemd/system/` にコピーし、次のように有効化します。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now x-autopost-api.service
sudo systemctl enable --now x-autopost.timer
```

## Ubuntu管理UI / アナリティクス

APIサーバ起動後、Ubuntuまたは同一LAN内のPC/スマホから `http://<UbuntuのIP>:8787/` を開くと管理UIを利用できます。

- `.env` の `ADMIN_TOKEN` を入力して、ブラウザのlocalStorageに保存します。
- ダッシュボードでは総投稿案、承認待ち、承認済み、投稿済み、失敗、承認率、投稿成功率を確認できます。
- 投稿軸別・日別スケジュール・直近の承認/却下/投稿イベントを可視化します。
- UIから1週間分の生成、投稿本文の保存、承認、却下、手動投稿チェックを実行できます。

## Android承認アプリ

`android/` は最小構成のネイティブAndroidアプリです。起動後に次を入力します。

- API URL: `http://<自宅UbuntuのIP>:8787`
- Admin Token: `.env` の `ADMIN_TOKEN`

`読み込み` でドラフト一覧を取得し、本文を確認して `承認` または `却下` を押します。承認された投稿だけがUbuntuの毎時実行ジョブから投稿対象になります。

## API

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 死活確認 |
| `GET` | `/api/posts?status=draft` | 投稿一覧取得 |
| `GET` | `/api/analytics` | Ubuntu管理UI用の集計値、グラフ、直近イベント取得 |
| `GET` | `/api/metrics` | 承認・却下・投稿などのイベント履歴取得 |
| `POST` | `/api/posts/generate-week` | 1週間分の投稿案生成 |
| `PATCH` | `/api/posts/:id` | 本文、日時、ステータス更新 |
| `POST` | `/api/posts/:id/approve` | 承認 |
| `POST` | `/api/posts/:id/reject` | 却下 |
| `POST` | `/api/tick` | 手動投稿チェック |

書き込み系APIは `Authorization: Bearer <ADMIN_TOKEN>` が必要です。
