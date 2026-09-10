#!/usr/bin/env bash
# ============================================================
# 自动打包并挂载下载链接
# 每次代码更新后运行本脚本，即可自动：
#   1. 打包纯净源码（排除 node_modules/dist/projects 副本/旧安装包/素材）
#   2. 输出到 public/ 供沙箱静态服务对外提供下载
#   3. 打印直接可用的下载链接
# 用法：bash pack-and-upload.sh
# ============================================================
set -e
cd "$(dirname "$0")"

ZIP_NAME="抖音直播录制工具V2-最新源码包-含一键打包.zip"
OUT="public/${ZIP_NAME}"
TMP_DIR="/tmp/douyin-src-pack-$$"

echo "==> [1/3] 打包纯净源码..."
rm -f "${OUT}"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"

tar \
  --exclude='./node_modules' --exclude='./dist' \
  --exclude='./projects' --exclude='./.git' --exclude='./.codegraph' \
  --exclude='./assets' \
  --exclude='./public/*.zip' --exclude='./public/*.tar.gz' \
  --exclude='./public/*.jpg' --exclude='./public/*.jpeg' \
  --exclude='./public/*.png' \
  -czf "/tmp/douyin-src.tar.gz" .
tar -xzf "/tmp/douyin-src.tar.gz" -C "${TMP_DIR}"

echo "==> [2/3] 生成 zip..."
python3 -c "
import zipfile, os, sys
src=sys.argv[1]; out=sys.argv[2]
if os.path.exists(out): os.remove(out)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for root,dirs,files in os.walk(src):
        for f in files:
            full=os.path.join(root,f)
            rel=os.path.relpath(full,src)
            if rel.startswith('.'): continue
            z.write(full,rel)
print('     zip bytes:', os.path.getsize(out))
" "${TMP_DIR}" "${OUT}"

rm -rf "${TMP_DIR}" /tmp/douyin-src.tar.gz

echo "==> [3/3] 完成 ✓"
VERSION=$(grep -m1 '"version"' package.json | sed 's/.*: *"\(.*\)",.*/\1/')
echo ""
echo "==================== 下载链接 ===================="
echo "版本号: ${VERSION}"
echo "文件:   public/${ZIP_NAME}  ($(du -h "${OUT}" | cut -f1))"
echo ""
FNAME_ENCODED=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "${ZIP_NAME}")
echo "链接:   ${COZE_PROJECT_DOMAIN_DEFAULT:-https://<你的域名>}/${FNAME_ENCODED}"
echo "=================================================="