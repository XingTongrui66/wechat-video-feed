#!/usr/bin/env bash
# 手动把最新 data/ 推到腾讯云 COS（GitHub Actions 自动上传之外的备选 / 调试用）。
# 手机端唯一可读源；与仓库里的 Actions 上传 step 二选一或并用。
set -e
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

# 读取密钥：优先 .env（已被 gitignore，不会上传），导出 COS_SECRET_ID / COS_SECRET_KEY
set -a
[ -f "$ROOT/.env" ] && source "$ROOT/.env"
set +a

COS_BUCKET="${COS_BUCKET:-vw-data-1311399697}"
COS_REGION="${COS_REGION:-ap-guangzhou}"

if [ -z "$COS_SECRET_ID" ] || [ -z "$COS_SECRET_KEY" ]; then
  echo "缺少 COS_SECRET_ID / COS_SECRET_KEY。"
  echo "请在 .env 里加上这两行（.env 已被 gitignore，不会上传到 GitHub）："
  echo "  COS_SECRET_ID=AKID..."
  echo "  COS_SECRET_KEY=..."
  exit 1
fi

# 复用隔离的 python venv 里的 coscmd（避免污染系统环境）
VENV="$HOME/.workbuddy/binaries/python/envs/default"
PY="$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if [ ! -f "$VENV/Scripts/coscmd.exe" ]; then
  "$PY" -m venv "$VENV"
  "$VENV/Scripts/python.exe" -m pip install -q coscmd
fi
COSCMD="$VENV/Scripts/coscmd.exe"

"$COSCMD" config -a "$COS_SECRET_ID" -s "$COS_SECRET_KEY" -b "$COS_BUCKET" -r "$COS_REGION" -m 10
"$COSCMD" upload data/official-feed.json data/official-feed.json
"$COSCMD" upload data/look-feed.json data/look-feed.json
"$COSCMD" upload data/channels-feed.json data/channels-feed.json
"$COSCMD" upload data/ai-review.json data/ai-review.json
if [ -d data/articles ]; then "$COSCMD" upload -r data/articles data/articles; fi
echo "COS 上传完成：手机端将从 COS 拉到最新数据"
