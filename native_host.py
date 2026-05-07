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
