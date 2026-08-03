#!/usr/bin/env bash
#
# GASプロジェクトへコードを反映し、Webアプリを同じURLのまま更新する。
#
# このプロジェクトはWebアプリを2本デプロイしている:
#
#   admin … 管理UI用。人間がスマホ/PCで開く。アクセス範囲は「自社ドメイン内のユーザー」
#           このURLがスクリプトプロパティ WEBAPP_URL に入っている
#   slack … Slack Event Subscriptions 専用。アクセス範囲は「全員」
#           このURLがSlackアプリの Request URL に入っている。人には配らない
#
# どちらを更新すべきか毎回考えなくて済むよう、IDを1度登録しておけば
# 以後は ./deploy.sh だけで両方が更新される。
#
# 使い方:
#   ./deploy.sh --save-admin AKfycb...   # 管理UI用のデプロイIDを登録（1度だけ）
#   ./deploy.sh --save-slack AKfycb...   # Slack用のデプロイIDを登録（1度だけ）
#   ./deploy.sh                          # push + 登録済みのデプロイを全部更新
#   ./deploy.sh AKfycb...                # push + 指定した1本だけ更新
#   ./deploy.sh --list                   # 登録内容と既存デプロイ一覧を表示
#
# デプロイIDは WebアプリURLの /macros/s/ と /exec の間の文字列（AKfycb…）。
set -euo pipefail
cd "$(dirname "$0")"

ADMIN_FILE=.deployment-id-admin
SLACK_FILE=.deployment-id-slack
LEGACY_FILE=.deployment-id   # 旧: 1本だけ保存していたころのファイル

valid_id() {
  printf '%s' "$1" | grep -Eq '^AKfycb[A-Za-z0-9_-]{20,}$'
}

save_id() {
  local file="$1" id="$2" label="$3"
  if ! valid_id "$id"; then
    echo "エラー: デプロイIDの形式が不正です: $id" >&2
    echo "WebアプリURLの /macros/s/ と /exec の間の文字列を指定してください。" >&2
    exit 1
  fi
  printf '%s\n' "$id" > "$file"
  echo "$label のデプロイIDを $file に保存しました。"
  exit 0
}

case "${1:-}" in
  --save-admin) save_id "$ADMIN_FILE" "${2:-}" "管理UI(admin)" ;;
  --save-slack) save_id "$SLACK_FILE" "${2:-}" "Slack(slack)" ;;
  --list)
    echo "== 登録済み =="
    if [ -f "$ADMIN_FILE" ]; then echo "  admin: $(cat "$ADMIN_FILE")"; else echo "  admin: (未登録) ./deploy.sh --save-admin AKfycb..."; fi
    if [ -f "$SLACK_FILE" ]; then echo "  slack: $(cat "$SLACK_FILE")"; else echo "  slack: (未登録) ./deploy.sh --save-slack AKfycb..."; fi
    echo ""
    echo "== GAS上の全デプロイ =="
    echo "（どちらがどちらか分からなくなったら、GASの「デプロイを管理」を開き、"
    echo "  アクセスできるユーザーが『自社ドメイン内』のほうが admin、"
    echo "  『全員』のほうが slack です）"
    clasp deployments || true
    exit 0
    ;;
esac

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp が見つかりません。先に: npm install -g @google/clasp && clasp login" >&2
  exit 1
fi

if [ ! -f .clasp.json ]; then
  echo ".clasp.json がありません。次を実行してください:" >&2
  echo "  cp .clasp.json.example .clasp.json  # scriptId をGASの プロジェクトの設定 からコピーして記入" >&2
  exit 1
fi

echo "==> clasp push（コードを反映）"
clasp push -f

# 更新対象を決める: 引数で1本指定 > 登録済みを全部
TARGETS=()
if [ "${1:-}" != "" ]; then
  TARGETS+=("$1|指定")
else
  [ -f "$ADMIN_FILE" ] && TARGETS+=("$(tr -d '[:space:]' < "$ADMIN_FILE")|管理UI")
  [ -f "$SLACK_FILE" ] && TARGETS+=("$(tr -d '[:space:]' < "$SLACK_FILE")|Slack")
  # 旧ファイルしか無い環境向け（admin として扱う）
  if [ ${#TARGETS[@]} -eq 0 ] && [ -f "$LEGACY_FILE" ]; then
    TARGETS+=("$(tr -d '[:space:]' < "$LEGACY_FILE")|管理UI(旧設定)")
  fi
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo ""
  echo "push は完了しました（時間トリガーの実行には反映済み）。"
  echo "Webアプリ(doGet/doPost)も更新するには、まずデプロイIDを登録してください:"
  echo "  ./deploy.sh --save-admin AKfycb...   # 管理UI用（WEBAPP_URL のもの）"
  echo "  ./deploy.sh --save-slack AKfycb...   # Slack用（SlackのRequest URLのもの）"
  echo ""
  echo "既存のデプロイ一覧:"
  clasp deployments || true
  exit 0
fi

FAILED=0
for entry in "${TARGETS[@]}"; do
  id="${entry%%|*}"
  label="${entry##*|}"
  if ! valid_id "$id"; then
    echo "エラー: $label のデプロイIDが不正です: $id" >&2
    FAILED=1
    continue
  fi
  echo "==> $label を新バージョンで更新: $id"
  if ! OUT="$(clasp deploy -i "$id" -d "cli $(date '+%Y-%m-%d %H:%M')" 2>&1)"; then
    echo "$OUT" >&2
    FAILED=1
    continue
  fi
  echo "$OUT"
  # claspはエラーでも終了コード0を返すことがあるため、出力からも失敗を検出する
  if printf '%s' "$OUT" | grep -qiE 'invalid|error|not found'; then
    echo "エラー: $label のデプロイ更新に失敗しました。上の出力を確認してください。" >&2
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "完了。URLは変わりません。"
