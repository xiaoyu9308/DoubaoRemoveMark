#!/bin/bash
# 豆包去水印 - 安装 / 同步 Native Messaging Host
#
# 作用：
#   1. 将项目里的 native_host.py 拷贝到 ~/Library/Application Support/DoubaoNativeHost/
#      （必须放在这里：~/Documents 会被 macOS TCC 拦截导致 Chrome 拉不起脚本）
#   2. 生成并注册 com.doubao.remove.mark.json 到 Chrome Native Messaging 目录
#   3. 幂等：以后每次修改 native_host.py 后，重跑一次这个脚本即可同步到运行位置
#
# 用法：
#   ./install_native_host.sh                  # 自动检测插件 ID
#   ./install_native_host.sh <extension_id>   # 手动指定插件 ID

set -e

# ========== 路径定义 ==========
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.doubao.remove.mark"
MANIFEST_FILE="$HOST_NAME.json"

# 源文件（项目内，写代码时编辑的）
SRC_HOST_PY="$SCRIPT_DIR/native_host.py"

# 运行目录（TCC 安全区，Chrome 实际从这里拉起脚本）
RUNTIME_DIR="$HOME/Library/Application Support/DoubaoNativeHost"
RUNTIME_HOST_PY="$RUNTIME_DIR/native_host.py"

# Chrome Native Messaging Host manifest 注册目录
CHROME_NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# ========== Step 1: 同步 native_host.py 到运行目录 ==========
if [ ! -f "$SRC_HOST_PY" ]; then
  echo "❌ 找不到源文件: $SRC_HOST_PY"
  exit 1
fi

mkdir -p "$RUNTIME_DIR"
cp "$SRC_HOST_PY" "$RUNTIME_HOST_PY"
chmod +x "$RUNTIME_HOST_PY"
# 清除 macOS 下载/复制时可能附带的 com.apple.quarantine 等 xattr，避免 Chrome 拒绝执行
xattr -c "$RUNTIME_HOST_PY" 2>/dev/null || true

echo "📦 已同步脚本:"
echo "   $SRC_HOST_PY"
echo "   → $RUNTIME_HOST_PY"

# ========== Step 2: 确定 Extension ID ==========
EXTENSION_ID="${1:-}"

if [ -z "$EXTENSION_ID" ]; then
  # 尝试从 Chrome Preferences 中自动获取
  for PROFILE_DIR in "Default" "Profile 1" "Profile 2" "Profile 3"; do
    PREF_FILE="$HOME/Library/Application Support/Google/Chrome/$PROFILE_DIR/Preferences"
    if [ -f "$PREF_FILE" ]; then
      EXTENSION_ID=$(python3 -c "
import json
with open('$PREF_FILE') as f:
    data = json.load(f)
exts = data.get('extensions', {}).get('settings', {})
for ext_id, ext_data in exts.items():
    manifest = ext_data.get('manifest', {})
    name = manifest.get('name', '')
    perms = manifest.get('permissions', [])
    if ('豆包' in name or '去水印' in name) and 'nativeMessaging' in perms:
        print(ext_id)
        break
" 2>/dev/null)
      [ -n "$EXTENSION_ID" ] && break
    fi
  done
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "⚠️  未能自动获取插件 ID"
  echo "   请在 Chrome 扩展管理页面 (chrome://extensions) 查看豆包去水印的 ID"
  read -p "请输入插件 Extension ID: " EXTENSION_ID
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "❌ 未提供 Extension ID，安装中止"
  exit 1
fi

echo "📌 插件 Extension ID: $EXTENSION_ID"

# ========== Step 3: 生成并注册 manifest ==========
# 注意：path 必须指向 RUNTIME_HOST_PY（TCC 安全区），不能指向项目目录下的源文件
mkdir -p "$CHROME_NMH_DIR"
cat > "$CHROME_NMH_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "豆包去水印 - Native Messaging Host",
  "path": "$RUNTIME_HOST_PY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

# 项目目录里也留一份 manifest 副本，方便查阅；但真正生效的是 Chrome 目录下的那份
cp "$CHROME_NMH_DIR/$HOST_NAME.json" "$SCRIPT_DIR/$MANIFEST_FILE"

echo ""
echo "✅ Native Messaging Host 安装/同步成功！"
echo "   Host 名称 : $HOST_NAME"
echo "   运行脚本 : $RUNTIME_HOST_PY"
echo "   注册清单 : $CHROME_NMH_DIR/$HOST_NAME.json"
echo "   插件 ID  : $EXTENSION_ID"
echo ""
echo "💡 以后每次修改 native_host.py 源码后，重跑本脚本即可同步到运行位置："
echo "   $ ./install_native_host.sh"
