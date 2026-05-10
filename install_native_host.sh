#!/bin/bash
# 豆包去水印 - 安装 / 同步 Native Messaging Host
#
# 作用：
#   1. 在 ~/Library/Application Support/DoubaoNativeHost/ 下原地生成 native_host.py
#      （不经过 ~/Documents 路径，避免 macOS 给文件附加 com.apple.provenance 属性
#        导致 TCC 追踪源头目录而拦截 Chrome 调用）
#   2. 生成并注册 com.doubao.remove.mark.json 到 Chrome Native Messaging 目录
#   3. 幂等：以后每次修改 native_host.py 后，修改下面的 HEREDOC 内容，重跑本脚本即可
#
# 用法：
#   ./install_native_host.sh                  # 自动检测插件 ID
#   ./install_native_host.sh <extension_id>   # 手动指定插件 ID

set -e

# ========== 路径定义 ==========
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.doubao.remove.mark"
MANIFEST_FILE="$HOST_NAME.json"

# 运行目录（TCC 安全区，Chrome 实际从这里拉起脚本）
RUNTIME_DIR="$HOME/Library/Application Support/DoubaoNativeHost"
RUNTIME_HOST_PY="$RUNTIME_DIR/native_host.py"

# Chrome Native Messaging Host manifest 注册目录
CHROME_NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# ========== Step 1: 在运行目录直接生成 native_host.py ==========
# 关键：用 heredoc 直接写入，不经过 ~/Documents 路径的任何读取，
# 这样 macOS 不会给文件附加 com.apple.provenance 属性
mkdir -p "$RUNTIME_DIR"

cat > "$RUNTIME_HOST_PY" << 'NATIVE_HOST_HEREDOC'
#!/usr/bin/python3
"""
豆包去水印 - Native Messaging Host
接收 Chrome 插件消息，执行 macOS open 命令打开文件夹
"""

# ============================================================
# 启动点日志 + 全局异常捕获
# 注意：必须放在文件最顶部，任何 import/代码出错都能被记录。
# 之前日志写入放在 read_message() 之后，导致早期崩溃时日志里看不到任何痕迹，
# Chrome 就只会笼统地报 "Native host has exited."。
# ============================================================
import os
import sys
import traceback
import datetime

_LOG_PATH = os.path.expanduser('~/doubao_native_host.log')


def _log(msg):
    try:
        with open(_LOG_PATH, 'a') as _f:
            _f.write(f'[{datetime.datetime.now()}] {msg}\n')
    except Exception:
        # 日志写不出也不能影响主流程
        pass


# 启动就先打一条点位日志，证明脚本被 Chrome 拉起来过
_log('========== native_host START ==========')
_log(f'  argv      = {sys.argv}')
_log(f'  executable= {sys.executable}')
_log(f'  cwd       = {os.getcwd()}')
_log(f'  python    = {sys.version}')
_log(f'  env.PATH  = {os.environ.get("PATH", "")!r}')
_log(f'  env.HOME  = {os.environ.get("HOME", "")!r}')


def _excepthook(exc_type, exc_value, exc_tb):
    """捕获所有未处理异常，写入日志后再退出"""
    _log('!!! UNCAUGHT EXCEPTION !!!')
    _log(''.join(traceback.format_exception(exc_type, exc_value, exc_tb)))


sys.excepthook = _excepthook


import struct
import json
import subprocess


def read_message():
    """从 stdin 读取 Chrome Native Messaging 消息"""
    _log('  read_message: waiting for 4-byte length header on stdin ...')
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        _log('  read_message: stdin closed (0 bytes) -> exit(0)')
        sys.exit(0)
    message_length = struct.unpack('=I', raw_length)[0]
    _log(f'  read_message: got length={message_length}, reading payload ...')
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    _log(f'  read_message: payload={message!r}')
    return json.loads(message)


def send_message(message):
    """向 stdout 写入 Chrome Native Messaging 消息"""
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    _log(f'  send_message: sent {len(encoded)} bytes -> {message}')


def main():
    message = read_message()
    command = message.get('command', '')
    path = message.get('path', '')

    _log(f'  Received: command={command}, path={path}')

    if command == 'ping':
        # 诊断命令：返回 Python 环境信息
        import platform
        info = {
            'success': True,
            'python': sys.version,
            'executable': sys.executable,
            'platform': platform.platform(),
            'cwd': os.getcwd(),
        }
        _log(f'  ping response: {info}')
        send_message(info)

    elif command == 'open' and path:
        try:
            # 如果目录不存在，先尝试自动创建（仅对用户家目录下的子目录生效，避免误创建系统目录）
            if not os.path.exists(path):
                home = os.path.expanduser('~')
                if path.startswith(home + '/') or path.startswith(home + os.sep):
                    try:
                        os.makedirs(path, exist_ok=True)
                        _log(f'  auto-created missing directory: {path}')
                    except Exception as mk_e:
                        _log(f'  failed to auto-create directory {path}: {mk_e}')
            result = subprocess.run(
                ['open', path],
                capture_output=True, text=True, timeout=5
            )
            _log(f'  returncode={result.returncode}, stdout={result.stdout!r}, stderr={result.stderr!r}')
            if result.returncode == 0:
                send_message({'success': True})
            else:
                send_message({'success': False, 'error': result.stderr.strip()})
        except Exception as e:
            _log(f'  Exception: {e}')
            send_message({'success': False, 'error': str(e)})
    else:
        send_message({'success': False, 'error': 'Unknown command or missing path'})


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        _log(f'!!! main() raised: {e}')
        _log(traceback.format_exc())
        raise
    finally:
        _log('========== native_host END ==========')
NATIVE_HOST_HEREDOC

chmod +x "$RUNTIME_HOST_PY"

# 验证无 com.apple.provenance 属性
if xattr -p com.apple.provenance "$RUNTIME_HOST_PY" 2>/dev/null; then
  echo "⚠️  仍有 com.apple.provenance 属性！尝试清除..."
  xattr -c "$RUNTIME_HOST_PY" 2>/dev/null || true
  # 如果还清除不掉，用 python3 重写
  if xattr -p com.apple.provenance "$RUNTIME_HOST_PY" 2>/dev/null; then
    echo "⚠️  xattr -c 未能清除 provenance，改用 python3 写入..."
    python3 << 'PY_WRITE'
import os
src = os.path.expanduser("~/Library/Application Support/DoubaoNativeHost/native_host.py")
with open(src, "r") as f:
    content = f.read()
# 用 python3 重写同一文件内容（绕过 cp/cat 的 provenance 追踪）
with open(src, "w") as f:
    f.write(content)
os.chmod(src, 0o755)
print("✅ 通过 Python 重写完成")
PY_WRITE
  fi
fi

echo "📦 已生成脚本:"
echo "   $RUNTIME_HOST_PY"
echo "   （通过 heredoc 直接生成，不经过 ~/Documents）"

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
echo "💡 以后每次修改 native_host.py 源码后，修改脚本中的 HEREDOC 内容，重跑本脚本即可："
echo "   $ ./install_native_host.sh"
