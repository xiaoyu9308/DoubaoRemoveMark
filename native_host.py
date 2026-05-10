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
# 默认不写调试日志。排查问题时可在 native messaging host 启动环境中设置 DOUBAO_DEBUG=1，
# 或在本文件顶部临时改为 True 打开（完成后依然必须重新部署到 ~/Library/Application Support/DoubaoNativeHost/）。
_DEBUG_LOG = os.environ.get('DOUBAO_DEBUG') == '1'


def _log(msg):
    if not _DEBUG_LOG:
        return
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
            # 目录不存在直接返回错误（不再自动创建，避免掩盖错误路径问题）
            if not os.path.exists(path):
                _log(f'  directory does not exist: {path}')
                send_message({'success': False, 'error': f'Directory does not exist: {path}'})
                return
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

    elif command == 'choose_dir':
        # 弹出 macOS 原生选择目录对话框，返回用户选择的绝对路径
        # 实现：osascript 调用 AppleScript "choose folder"
        # 注意：osascript 返回的是 HFS 风格路径（如 "Macintosh HD:Users:mars:Downloads:"），
        #      需要用 POSIX path 转成 "/Users/mars/Downloads"
        prompt = message.get('prompt', '请选择下载目录')
        default_loc = message.get('default_location', '')
        _log(f'  choose_dir: prompt={prompt!r}, default_location={default_loc!r}')
        try:
            # 默认到用户 home 而非 Downloads，避免 osascript 为读取 Downloads 触发 macOS TCC 权限弹窗。
            # 仅在调用方明确传了一个非受保护路径时才使用该路径作为默认位置。
            home_dir = os.path.expanduser('~')
            tcc_protected = (
                home_dir + '/Downloads',
                home_dir + '/Documents',
                home_dir + '/Desktop',
            )
            effective_default = ''
            if default_loc and os.path.isdir(default_loc) and default_loc not in tcc_protected:
                effective_default = default_loc
            else:
                effective_default = home_dir

            # 构造 AppleScript：可选 default location；返回 POSIX path 字符串
            if effective_default and os.path.isdir(effective_default):
                script = (
                    f'set chosen to choose folder with prompt "{prompt}" '
                    f'default location POSIX file "{effective_default}"\n'
                    f'return POSIX path of chosen'
                )
            else:
                script = (
                    f'set chosen to choose folder with prompt "{prompt}"\n'
                    f'return POSIX path of chosen'
                )
            _log(f'  choose_dir: running osascript script:\n{script}')
            result = subprocess.run(
                ['osascript', '-e', script],
                capture_output=True, text=True, timeout=120
            )
            _log(f'  choose_dir: returncode={result.returncode}, stdout={result.stdout!r}, stderr={result.stderr!r}')
            if result.returncode != 0:
                # returncode=1 通常是用户取消（"User canceled."）
                err = (result.stderr or '').strip()
                if 'User canceled' in err or '-128' in err:
                    _log('  choose_dir: user canceled')
                    send_message({'success': False, 'canceled': True, 'error': 'User canceled'})
                else:
                    send_message({'success': False, 'error': err or 'osascript failed'})
                return
            # 去掉末尾换行 / 末尾斜杠（POSIX path 对目录会带尾部 /）
            chosen_path = result.stdout.strip()
            if chosen_path.endswith('/') and len(chosen_path) > 1:
                chosen_path = chosen_path[:-1]
            _log(f'  choose_dir: SUCCESS chosen_path={chosen_path!r}')
            if not chosen_path or not os.path.isdir(chosen_path):
                send_message({'success': False, 'error': f'Invalid path returned: {chosen_path!r}'})
                return
            send_message({'success': True, 'path': chosen_path})
        except subprocess.TimeoutExpired:
            _log('  choose_dir: osascript timeout (120s)')
            send_message({'success': False, 'error': 'choose folder dialog timeout'})
        except Exception as e:
            _log(f'  choose_dir Exception: {e}')
            _log(traceback.format_exc())
            send_message({'success': False, 'error': str(e)})

    elif command == 'write_file':
        # 把 base64 内容写入指定绝对路径的文件
        # 用于：popup 通过 native host 把图片写入用户选择的任意目录
        import base64
        target_dir = message.get('dir', '')
        filename = message.get('filename', '')
        b64 = message.get('data_base64', '')
        _log(f'  write_file: dir={target_dir!r}, filename={filename!r}, data_len={len(b64)}')
        if not target_dir or not filename:
            send_message({'success': False, 'error': 'Missing dir or filename'})
            return
        try:
            # 安全：filename 不能包含路径分隔符，避免越权写入
            if '/' in filename or '\\' in filename or filename.startswith('.'):
                send_message({'success': False, 'error': f'Invalid filename: {filename}'})
                return
            if not os.path.isdir(target_dir):
                _log(f'  write_file: dir not exist: {target_dir}')
                send_message({'success': False, 'error': f'Directory does not exist: {target_dir}'})
                return
            full_path = os.path.join(target_dir, filename)
            # 处理重名：在文件名后追加 (1) (2) ...
            if os.path.exists(full_path):
                base, ext = os.path.splitext(filename)
                idx = 1
                while True:
                    cand = os.path.join(target_dir, f'{base} ({idx}){ext}')
                    if not os.path.exists(cand):
                        full_path = cand
                        break
                    idx += 1
                _log(f'  write_file: filename conflict, using {full_path}')
            raw = base64.b64decode(b64)
            with open(full_path, 'wb') as f:
                f.write(raw)
            _log(f'  write_file: SUCCESS wrote {len(raw)} bytes to {full_path}')
            send_message({'success': True, 'path': full_path, 'bytes': len(raw)})
        except Exception as e:
            _log(f'  write_file Exception: {e}')
            _log(traceback.format_exc())
            send_message({'success': False, 'error': str(e)})

    elif command == 'resolve_dir':
        # 通过独特文件名在系统中定位文件所在目录的绝对路径
        # 适用场景：popup 用 File System Access API 写入了一个独特名字的探针文件，
        #          但拿不到绝对路径；这里用 mdfind 搜索整个系统找到该文件，
        #          返回其所在目录的绝对路径。
        marker = message.get('marker_filename', '')
        # 客户端可以传入候选搜索根列表（可选）
        client_search_roots = message.get('search_roots', []) or []
        if not marker:
            send_message({'success': False, 'error': 'Missing marker_filename'})
            return

        def _try_mdfind(timeout=4):
            """用 mdfind 进行 Spotlight 搜索（最快，但需要文件被索引）"""
            try:
                result = subprocess.run(
                    ['mdfind', '-name', marker],
                    capture_output=True, text=True, timeout=timeout
                )
                _log(f'  mdfind returncode={result.returncode}, stdout={result.stdout!r}')
                hits = [p for p in result.stdout.strip().split('\n') if p and os.path.basename(p) == marker]
                # 过滤实际存在的（mdfind 索引可能滞后）
                return [p for p in hits if os.path.isfile(p)]
            except Exception as e:
                _log(f'  mdfind error: {e}')
                return []

        def _try_find(root, timeout=6):
            """用 find 进行实时遍历搜索（慢但可靠）。
               -print -quit: 找到第一个就停止，避免遍历整个目录树。
               2>/dev/null: 屏蔽权限拒绝错误。
               -maxdepth 7: 限制深度避免太慢。
            """
            if not os.path.isdir(root):
                return []
            try:
                # 注意：-maxdepth 必须紧跟路径，-print -quit 必须放最后
                result = subprocess.run(
                    f"find '{root}' -maxdepth 7 -name '{marker}' -print -quit 2>/dev/null",
                    capture_output=True, text=True, timeout=timeout, shell=True
                )
                _log(f'  find {root}: returncode={result.returncode}, stdout={result.stdout!r}')
                hits = [p for p in result.stdout.strip().split('\n') if p and os.path.basename(p) == marker]
                return [p for p in hits if os.path.isfile(p)]
            except Exception as e:
                _log(f'  find {root} error: {e}')
                return []

        try:
            paths = []

            # 策略 1: mdfind（Spotlight 索引，最快）
            paths = _try_mdfind(timeout=4)

            # 策略 2: 客户端提供的候选根（若有）
            if not paths and client_search_roots:
                _log(f'  mdfind miss, trying client search_roots: {client_search_roots}')
                for root in client_search_roots:
                    expanded = os.path.expanduser(root)
                    paths = _try_find(expanded, timeout=4)
                    if paths:
                        break

            # 策略 3: 系统常见根目录
            if not paths:
                _log('  no hit yet, trying system common roots')
                home = os.environ.get('HOME', os.path.expanduser('~'))
                # 注意：这些路径可能因 macOS TCC 权限保护无法访问，但能访问的会快速命中
                fallback_roots = [
                    home + '/Downloads',
                    home + '/Documents',
                    home + '/Desktop',
                    home + '/Library/Mobile Documents/com~apple~CloudDocs',
                    home + '/Library/CloudStorage',
                    home + '/Pictures',
                    home + '/Movies',
                    home + '/Music',
                    home,
                    '/Volumes',
                    '/tmp',
                ]
                for root in fallback_roots:
                    paths = _try_find(root, timeout=5)
                    if paths:
                        break

            if not paths:
                _log(f'  resolve_dir: marker {marker} NOT FOUND anywhere')
                send_message({
                    'success': False,
                    'error': 'Marker file not found by mdfind/find',
                    'searched_client_roots': client_search_roots,
                })
                return

            # 取第一个命中
            file_path = paths[0]
            dir_path = os.path.dirname(file_path)
            _log(f'  resolve_dir SUCCESS: dir={dir_path}, file={file_path}')
            send_message({'success': True, 'path': dir_path, 'file': file_path, 'all_hits': paths})
        except Exception as e:
            _log(f'  resolve_dir Exception: {e}')
            _log(traceback.format_exc())
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
