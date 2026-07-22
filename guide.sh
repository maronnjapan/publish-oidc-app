#!/usr/bin/env bash
# Maronn OIDC Publisher 半自動セットアップガイド
#   ./guide.sh          未完了ステップを順番に実行
#   ./guide.sh status   進捗を表示
#   ./guide.sh reset    進捗だけをリセット（Cloudflare資源は削除しない）
#   ./guide.sh help     ヘルプ

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

STATE_FILE=".setup-guide-state"
CONFIG_FILE=".setup-guide-config"
MIN_NODE_MAJOR=22

if [ -t 1 ]; then
  C_RESET="\033[0m"; C_BOLD="\033[1m"; C_DIM="\033[2m"
  C_RED="\033[31m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_BLUE="\033[34m"; C_CYAN="\033[36m"
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

step() { printf "\n${C_BOLD}${C_BLUE}=== %s ===${C_RESET}\n" "$*"; }
info() { printf "${C_CYAN}ℹ %s${C_RESET}\n" "$*"; }
ok() { printf "${C_GREEN}✔ %s${C_RESET}\n" "$*"; }
warn() { printf "${C_YELLOW}⚠ %s${C_RESET}\n" "$*"; }
err() { printf "${C_RED}✗ %s${C_RESET}\n" "$*" >&2; }

confirm() {
  local answer prompt="${1:-続行しますか？}"
  printf "${C_BOLD}%s (y/N): ${C_RESET}" "$prompt"
  read -r answer || return 1
  [ "$answer" != "${answer#[Yy]}" ]
}

prompt_value() {
  local label="$1" default="${2:-}" answer
  if [ -n "$default" ]; then printf "${C_BOLD}%s [%s]: ${C_RESET}" "$label" "$default" >&2; else printf "${C_BOLD}%s: ${C_RESET}" "$label" >&2; fi
  read -r answer || return 1
  printf '%s' "${answer:-$default}"
}

prompt_secret() {
  local variable="$1" label="$2" value current="${!1:-}"
  if [ -n "$current" ]; then ok "$variable は現在の環境に設定済みです。"; return 0; fi
  printf "${C_BOLD}%s（入力は表示されません）: ${C_RESET}" "$label"
  IFS= read -rs value || return 1
  printf '\n'
  [ -n "$value" ] || { err "$variable が空です。"; return 1; }
  printf -v "$variable" '%s' "$value"
  export "$variable"
}

run_confirmed() {
  local label="$1"; shift
  info "実行: $*"
  confirm "$label を実行しますか？" || { warn "スキップしました。"; return 1; }
  "$@" || { err "$label に失敗しました。"; return 1; }
  ok "$label が完了しました。"
}

mark_done() { grep -qxF "$1" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$1" >> "$STATE_FILE"; }
is_done() { grep -qxF "$1" "$STATE_FILE" 2>/dev/null; }

save_config() {
  local key="$1" value="$2" temporary="${CONFIG_FILE}.tmp"
  case "$value" in *$'\n'*|*$'\r'*) err "設定値に改行は使えません。"; return 1;; esac
  touch "$CONFIG_FILE" && chmod 600 "$CONFIG_FILE"
  grep -v "^${key}=" "$CONFIG_FILE" > "$temporary" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  mv "$temporary" "$CONFIG_FILE" && chmod 600 "$CONFIG_FILE"
}

load_config() { [ -f "$CONFIG_FILE" ] && grep "^${1}=" "$CONFIG_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

load_target() {
  CLOUDFLARE_ACCOUNT_ID="$(load_config CLOUDFLARE_ACCOUNT_ID)"
  GITHUB_REPOSITORY="$(load_config GITHUB_REPOSITORY)"
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && [ -n "$GITHUB_REPOSITORY" ] || { err "Step 1 の設定がありません。"; return 1; }
  export CLOUDFLARE_ACCOUNT_ID GITHUB_REPOSITORY
}

step0() {
  step "Step 0: 前提条件の確認"
  cat <<'EOF'
必要なもの:
  - Node.js 22以上 / npm
  - Git と、mainへpush済みのGitHubリポジトリ
  - 認証済みGitHub CLI (gh)
  - workers.devサブドメインを設定済みのCloudflareアカウント

このガイドはCloudflare REST APIを直接使います。wranglerは不要です。
EOF
  [ -f package.json ] && [ -f scripts/setup.mjs ] || { err "リポジトリルートで実行してください。"; return 1; }
  local failed=0 command_name node_major
  for command_name in node npm git gh; do command -v "$command_name" >/dev/null 2>&1 && ok "$command_name を確認" || { err "$command_name がありません。"; failed=1; }; done
  if command -v node >/dev/null 2>&1; then node_major="$(node -p 'process.versions.node.split(".")[0]')"; [ "$node_major" -ge "$MIN_NODE_MAJOR" ] || { err "Node.js 22以上が必要です。"; failed=1; }; fi
  gh auth status >/dev/null 2>&1 || { err "gh auth login を先に実行してください。"; failed=1; }
  [ "$failed" -eq 0 ] || return 1
  mark_done step0
}

step1() {
  step "Step 1: CloudflareアカウントとGitHubリポジトリ"
  cat <<'EOF'
Cloudflare Dashboardで対象アカウントのAccount ID（32文字）を確認してください。
Workers & Pagesでworkers.devサブドメインが有効であることも確認します。
GitHubはこのコードが置かれた owner/repository を指定します。
ここで保存する値は秘密ではありません。API TokenやPATは保存しません。
EOF
  local account repository detected=""
  detected="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#.*github.com[:/]([^/]+)/(.*)(\.git)?$#\1/\2#; s#\.git$##' || true)"
  account="$(prompt_value "Cloudflare Account ID" "$(load_config CLOUDFLARE_ACCOUNT_ID)")" || return 1
  repository="$(prompt_value "GitHub repository (owner/repository)" "$(load_config GITHUB_REPOSITORY)")" || return 1
  [ -n "$repository" ] || repository="$detected"
  [[ "$account" =~ ^[0-9a-fA-F]{32}$ ]] || { err "Account IDの形式が不正です。"; return 1; }
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { err "owner/repository形式で入力してください。"; return 1; }
  gh repo view "$repository" --json nameWithOwner -q .nameWithOwner >/dev/null 2>&1 || { err "$repository へアクセスできません。"; return 1; }
  save_config CLOUDFLARE_ACCOUNT_ID "${account,,}" && save_config GITHUB_REPOSITORY "$repository" || return 1
  mark_done step1
  ok "対象を保存しました。"
}

step2() {
  step "Step 2: 最小権限TokenとGitHub Secrets"
  cat <<'EOF'
Cloudflare API Tokenを Custom Token として作成します。
対象Accountを1つに限定し、Account permissionsへ次を追加してください。
  - Workers Scripts: Edit
  - D1: Edit

このTokenは24時間後の自動削除を行うReaper WorkerにもSecretとして設定され、
対象OP WorkerをCloudflare APIで削除するために使われます。

次にGitHub Fine-grained PATを対象リポジトリだけに限定して作成します。
Repository permissionsは Actions: Read and write が必要です。

Repository Secretsには次の名前で登録します。
  CLOUDFLARE_API_TOKEN  Cloudflare Token
  PORTAL_GITHUB_TOKEN   Fine-grained PAT
EOF
  load_target || return 1
  prompt_secret CLOUDFLARE_API_TOKEN "Cloudflare API Token" || return 1
  prompt_secret PORTAL_GITHUB_TOKEN "GitHub Fine-grained PAT" || return 1
  info "Tokenの値はファイルへ保存せず、標準入力でghへ渡します。"
  confirm "$GITHUB_REPOSITORY のSecretsを作成・更新しますか？" || return 1
  printf '%s' "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN --repo "$GITHUB_REPOSITORY" || return 1
  printf '%s' "$PORTAL_GITHUB_TOKEN" | gh secret set PORTAL_GITHUB_TOKEN --repo "$GITHUB_REPOSITORY" || return 1
  mark_done step2
  ok "Secretsを登録しました。"
}

step3() {
  step "Step 3: ローカル検証"
  cat <<'EOF'
依存関係をlockfileどおりに導入し、型チェック、テスト、ポータルビルドを行います。
テストでは@maronn-oidc/cliのHono生成物をWorkers向けに実際にbundleします。
EOF
  run_confirmed "npm ci" npm ci || return 1
  run_confirmed "全チェック" npm run check || return 1
  mark_done step3
}

step4() {
  step "Step 4: 共有D1の作成"
  cat <<'EOF'
Cloudflare APIで maronn-oidc-shared-d1 を作成または再利用し、次を作ります。
  - ポータルのリクエスト・IP/全体レート制限台帳
  - OPの作成時刻・24時間の有効期限を持つ削除対象台帳
  - 最大5ユーザーの個別salt付きSHA-256パスワードハッシュ
  - 全OPの認可コード、トークン、セッション、同意状態

全テーブルはWorkerのサブドメインラベル(op_id)で名前空間分離されます。
KV/R2やOPごとのD1は作りません。処理は冪等で、既存データを削除しません。
EOF
  load_target || return 1
  prompt_secret CLOUDFLARE_API_TOKEN "Cloudflare API Token" || return 1
  run_confirmed "共有D1とスキーマのセットアップ" node scripts/setup.mjs || return 1
  node -e 'const i=require("./infra.json"); for(const k of ["account_id","workers_dev_subdomain","d1_database_id","github_owner","github_repo"]) if(!i[k]) throw new Error("infra.json: "+k+" is missing")' || return 1
  mark_done step4
}

step5() {
  step "Step 5: infra.jsonの反映とシステムWorkerのデプロイ"
  cat <<'EOF'
GitHub Actionsで生成OPをデプロイするため、生成済みinfra.jsonとこのコード一式が
mainブランチへpushされている必要があります。未反映なら別ターミナルで確認後、
  git add . && git commit -m "feat: add OIDC provider publisher" && git push origin main
を実行してください。コミット対象に秘密ファイルがないことを必ず確認してください。

続いて次の2つのシステムWorkerをCloudflare REST APIでデプロイします。

  maronn-oidc-reaper
    - 15分ごとのcronで、デプロイから24時間を過ぎたOP Workerを削除
    - 共有D1のユーザー、トークン、セッション、同意、発行台帳もop_id単位で削除
    - 既存registry_opsへexpires_atを追加・補完する移行も自動適用

  maronn-oidc-portal
    - OP発行UIを公開
    - 既定の制限は1 IPあたり1日10回、全体で1日50回（UTCリセット）

Reaperはmaronn-op-から始まる厳密なOP IDだけを削除し、ポータルやReaper自身を
削除対象にしません。Cloudflare API TokenはReaperのWorker Secretへ登録されます。
EOF
  load_target || return 1
  prompt_secret CLOUDFLARE_API_TOKEN "Cloudflare API Token" || return 1
  prompt_secret PORTAL_GITHUB_TOKEN "GitHub Fine-grained PAT" || return 1
  confirm "コードとinfra.jsonがGitHubのmainにpush済みですか？" || return 1
  export GITHUB_DISPATCH_TOKEN="$PORTAL_GITHUB_TOKEN"
  run_confirmed "24時間自動削除Reaperのデプロイ" npm run deploy:reaper || return 1
  run_confirmed "ポータルWorkerのデプロイ" npm run deploy:portal || return 1
  mark_done step5_reaper
}

step6() {
  step "Step 6: 疎通確認"
  local portal_url
  portal_url="$(node -e 'const i=require("./infra.json"); process.stdout.write(`https://maronn-oidc-portal.${i.workers_dev_subdomain}.workers.dev`)')" || return 1
  cat <<EOF
ポータルURL:
  $portal_url

ブラウザで開き、次を含むOPを1件作成してください。
  1. HTTPS（またはlocalhost HTTP）のリダイレクトURL
  2. openidに加えるスコープ
  3. public / confidential
  4. PKCE等の機能
  5. UI入力またはCSVの1〜5ユーザー

完了後、publicならOP URLとClient ID、confidentialなら加えてClient Secretが
一度だけ表示されます。OP URLの /.well-known/openid-configuration も確認します。
発行したOP Workerとその共有D1データは、デプロイから約24時間後（cron間隔を含め
最大約24時間15分後）に自動削除されます。機微な本番データは登録しないでください。
EOF
  if command -v curl >/dev/null 2>&1; then curl --fail --silent --show-error "$portal_url/api/quota" >/dev/null && ok "ポータルAPIが応答しました。" || warn "まだ応答しません。デプロイログを確認してください。"; fi
  confirm "画面からOPを作成し、発行情報とDiscoveryを確認できましたか？" || return 1
  mark_done step6
  ok "セットアップは完了です。"
}

show_status() {
  step "セットアップ進捗"
  local number label
  for number in 0 1 2 3 4 5 6; do
    case "$number" in
      0) label="前提条件";; 1) label="対象選択";; 2) label="Secrets";; 3) label="ローカル検証";; 4) label="共有D1";; 5) label="Reaper / ポータル";; 6) label="疎通確認";;
    esac
    local state_key="step$number"
    [ "$number" -eq 5 ] && state_key="step5_reaper"
    if is_done "$state_key"; then printf "  ${C_GREEN}[完了]${C_RESET} Step %s: %s\n" "$number" "$label"; else printf "  ${C_DIM}[未完]${C_RESET} Step %s: %s\n" "$number" "$label"; fi
  done
  printf '\n  Cloudflare Account: %s\n  GitHub repository:  %s\n' "$(load_config CLOUDFLARE_ACCOUNT_ID)" "$(load_config GITHUB_REPOSITORY)"
}

run_all() {
  local number state_key
  for number in 0 1 2 3 4 5 6; do
    state_key="step$number"
    [ "$number" -eq 5 ] && state_key="step5_reaper"
    if is_done "$state_key"; then info "Step $number は完了済みです。"; continue; fi
    "step$number" || { warn "Step $number で停止しました。修正後に ./guide.sh を再実行してください。"; return 1; }
  done
  show_status
}

case "${1:-run}" in
  run) run_all;;
  status) show_status;;
  reset) confirm "進捗ファイルだけをリセットしますか？（Cloudflare資源は削除しません）" && { : > "$STATE_FILE"; ok "進捗をリセットしました。"; };;
  help|-h|--help) sed -n '2,6p' "$0";;
  *) err "usage: ./guide.sh [status|reset|help]"; exit 2;;
esac
