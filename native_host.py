#!/usr/bin/python3
"""
豆包去水印 - Native Messaging Host
接收 Chrome 插件消息，执行 macOS open 命令打开文件夹
"""

import os
import sys
import struct
import json
import subprocess
import threading


def read_message():
    """从 stdin 读取 Chrome Native Messaging 消息"""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    message_length = struct.unpack('=I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)


def send_message(message):
    """向 stdout 写入 Chrome Native Messaging 消息（线程安全）"""
    _send_lock.acquire()
    try:
        encoded = json.dumps(message).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    finally:
        _send_lock.release()

# send_message 的线程锁：ThreadPoolExecutor 并行下载时，多个线程会同时调用 send_message
# 推送进度，stdout 不是线程安全的，必须加锁
_send_lock = threading.Lock()


def handle_message(message):
    """处理单条消息（可在子线程中运行）"""
    command = message.get('command', '')
    path = message.get('path', '')

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
        send_message(info)

    elif command == 'open' and path:
        try:
            # 目录不存在直接返回错误（不再自动创建，避免掩盖错误路径问题）
            if not os.path.exists(path):
                send_message({'success': False, 'error': f'Directory does not exist: {path}'})
                return
            result = subprocess.run(
                ['open', path],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                send_message({'success': True})
            else:
                send_message({'success': False, 'error': result.stderr.strip()})
        except Exception as e:
            send_message({'success': False, 'error': str(e)})

    elif command == 'choose_dir':
        # 弹出 macOS 原生选择目录对话框，返回用户选择的绝对路径
        # 实现：osascript 调用 AppleScript "choose folder"
        # 注意：osascript 返回的是 HFS 风格路径（如 "Macintosh HD:Users:mars:Downloads:"），
        #      需要用 POSIX path 转成 "/Users/mars/Downloads"
        prompt = message.get('prompt', '请选择下载目录')
        default_loc = message.get('default_location', '')
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
            result = subprocess.run(
                ['osascript', '-e', script],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                # returncode=1 通常是用户取消（"User canceled."）
                err = (result.stderr or '').strip()
                if 'User canceled' in err or '-128' in err:
                    send_message({'success': False, 'canceled': True, 'error': 'User canceled'})
                else:
                    send_message({'success': False, 'error': err or 'osascript failed'})
                return
            # 去掉末尾换行 / 末尾斜杠（POSIX path 对目录会带尾部 /）
            chosen_path = result.stdout.strip()
            if chosen_path.endswith('/') and len(chosen_path) > 1:
                chosen_path = chosen_path[:-1]
            if not chosen_path or not os.path.isdir(chosen_path):
                send_message({'success': False, 'error': f'Invalid path returned: {chosen_path!r}'})
                return
            send_message({'success': True, 'path': chosen_path})
        except subprocess.TimeoutExpired:
            send_message({'success': False, 'error': 'choose folder dialog timeout'})
        except Exception as e:
            send_message({'success': False, 'error': str(e)})

    elif command == 'download_url':
        # 直接用 Python 并行下载 URL 到指定目录
        # 省去浏览器 fetch + base64 转换 + native messaging 传输的开销
        # 使用 ThreadPoolExecutor 并行下载，每完成一张就通过 stdout 回调推送进度
        import base64
        import urllib.request
        import urllib.parse
        import time
        from concurrent.futures import ThreadPoolExecutor, as_completed

        target_dir = message.get('dir', '')
        items = message.get('items', [])  # [{filename, url}, ...]

        if not target_dir or not items:
            send_message({'success': False, 'error': 'Missing dir or items'})
            return
        if not os.path.isdir(target_dir):
            send_message({'success': False, 'error': f'Directory does not exist: {target_dir}'})
            return

        total_count = len(items)
        progress_lock = threading.Lock()
        progress_completed = 0
        progress_success = 0
        progress_fail = 0

        def download_one_item(idx, item):
            """下载单个文件，返回结果 dict"""
            filename = item.get('filename', '')
            url = item.get('url', '')
            if not filename or not url:
                return {'filename': filename, 'success': False, 'error': 'Missing filename or url'}

            # 安全：filename 不能包含路径分隔符
            if '/' in filename or '\\' in filename or filename.startswith('.'):
                return {'filename': filename, 'success': False, 'error': f'Invalid filename: {filename}'}

            full_path = os.path.join(target_dir, filename)
            # 处理重名
            if os.path.exists(full_path):
                base, ext = os.path.splitext(filename)
                i = 1
                while True:
                    cand = os.path.join(target_dir, f'{base} ({i}){ext}')
                    if not os.path.exists(cand):
                        full_path = cand
                        break
                    i += 1

            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Accept': 'image/*',
                })
                with urllib.request.urlopen(req, timeout=30) as resp:
                    with open(full_path, 'wb') as f:
                        total_read = 0
                        while True:
                            chunk = resp.read(65536)
                            if not chunk:
                                break
                            f.write(chunk)
                            total_read += len(chunk)
                file_size = os.path.getsize(full_path)
                return {'filename': filename, 'success': True, 'path': full_path, 'bytes': file_size}
            except urllib.error.URLError as ue:
                return {'filename': filename, 'success': False, 'error': f'URLError: {ue.reason}'}
            except urllib.error.HTTPError as he:
                return {'filename': filename, 'success': False, 'error': f'HTTP {he.code}: {he.reason}'}
            except Exception as e:
                return {'filename': filename, 'success': False, 'error': str(e)}

        def on_item_complete(idx, item, result):
            """每完成一个下载就回调推送进度消息"""
            nonlocal progress_completed, progress_success, progress_fail
            with progress_lock:
                progress_completed += 1
                if result.get('success'):
                    progress_success += 1
                else:
                    progress_fail += 1
                completed = progress_completed
                success = progress_success
                fail = progress_fail

            # 回调推送进度消息
            send_message({
                'type': 'download_progress',
                'completed': completed,
                'total': total_count,
                'success': success,
                'fail': fail,
                'filename': result.get('filename', ''),
                'item_success': result.get('success', False),
                'item_error': result.get('error', None),
            })

        # 使用 ThreadPoolExecutor 并行下载
        results = []
        with ThreadPoolExecutor(max_workers=min(8, total_count)) as executor:
            future_to_item = {}
            for idx, item in enumerate(items):
                future = executor.submit(download_one_item, idx, item)
                future_to_item[future] = (idx, item)

            for future in as_completed(future_to_item):
                idx, item = future_to_item[future]
                try:
                    result = future.result()
                    result['index'] = idx
                except Exception as e:
                    filename = item.get('filename', '')
                    result = {'filename': filename, 'success': False, 'error': str(e), 'index': idx}

                results.append(result)
                on_item_complete(idx, item, result)

        # 按原始索引排序结果
        results.sort(key=lambda r: r.get('index', 0))

        success_count = sum(1 for r in results if r.get('success'))
        fail_count = len(results) - success_count

        # 发送最终完成消息
        send_message({
            'type': 'download_complete',
            'success': True,
            'results': results,
            'success_count': success_count,
            'fail_count': fail_count,
        })

    elif command == 'batch_write':
        # 批量写入多个文件（一次 native messaging 往返）
        # 减少 Chrome ↔ Python 进程之间的通信开销
        import base64
        target_dir = message.get('dir', '')
        files = message.get('files', [])  # [{filename, data_base64}, ...]
        if not target_dir or not files:
            send_message({'success': False, 'error': 'Missing dir or files'})
            return
        if not os.path.isdir(target_dir):
            send_message({'success': False, 'error': f'Directory does not exist: {target_dir}'})
            return
        results = []
        for f_info in files:
            filename = f_info.get('filename', '')
            b64 = f_info.get('data_base64', '')
            if not filename or not b64:
                results.append({'filename': filename, 'success': False, 'error': 'Missing filename or data'})
                continue
            try:
                # 安全：filename 不能包含路径分隔符
                if '/' in filename or '\\' in filename or filename.startswith('.'):
                    results.append({'filename': filename, 'success': False, 'error': f'Invalid filename: {filename}'})
                    continue
                full_path = os.path.join(target_dir, filename)
                # 处理重名
                if os.path.exists(full_path):
                    base, ext = os.path.splitext(filename)
                    idx = 1
                    while True:
                        cand = os.path.join(target_dir, f'{base} ({idx}){ext}')
                        if not os.path.exists(cand):
                            full_path = cand
                            break
                        idx += 1
                raw = base64.b64decode(b64)
                with open(full_path, 'wb') as f:
                    f.write(raw)
                results.append({'filename': filename, 'success': True, 'path': full_path, 'bytes': len(raw)})
            except Exception as e:
                results.append({'filename': filename, 'success': False, 'error': str(e)})
        success_count = sum(1 for r in results if r.get('success'))
        fail_count = len(results) - success_count
        send_message({'success': True, 'results': results, 'success_count': success_count, 'fail_count': fail_count})

    elif command == 'write_file':
        # 把 base64 内容写入指定绝对路径的文件
        # 用于：popup 通过 native host 把图片写入用户选择的任意目录
        import base64
        target_dir = message.get('dir', '')
        filename = message.get('filename', '')
        b64 = message.get('data_base64', '')
        if not target_dir or not filename:
            send_message({'success': False, 'error': 'Missing dir or filename'})
            return
        try:
            # 安全：filename 不能包含路径分隔符，避免越权写入
            if '/' in filename or '\\' in filename or filename.startswith('.'):
                send_message({'success': False, 'error': f'Invalid filename: {filename}'})
                return
            if not os.path.isdir(target_dir):
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
            raw = base64.b64decode(b64)
            with open(full_path, 'wb') as f:
                f.write(raw)
            send_message({'success': True, 'path': full_path, 'bytes': len(raw)})
        except Exception as e:
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
                hits = [p for p in result.stdout.strip().split('\n') if p and os.path.basename(p) == marker]
                # 过滤实际存在的（mdfind 索引可能滞后）
                return [p for p in hits if os.path.isfile(p)]
            except Exception:
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
                hits = [p for p in result.stdout.strip().split('\n') if p and os.path.basename(p) == marker]
                return [p for p in hits if os.path.isfile(p)]
            except Exception:
                return []

        try:
            paths = []

            # 策略 1: mdfind（Spotlight 索引，最快）
            paths = _try_mdfind(timeout=4)

            # 策略 2: 客户端提供的候选根（若有）
            if not paths and client_search_roots:
                for root in client_search_roots:
                    expanded = os.path.expanduser(root)
                    paths = _try_find(expanded, timeout=4)
                    if paths:
                        break

            # 策略 3: 系统常见根目录
            if not paths:
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
                send_message({
                    'success': False,
                    'error': 'Marker file not found by mdfind/find',
                    'searched_client_roots': client_search_roots,
                })
                return

            # 取第一个命中
            file_path = paths[0]
            dir_path = os.path.dirname(file_path)
            send_message({'success': True, 'path': dir_path, 'file': file_path, 'all_hits': paths})
        except Exception as e:
            send_message({'success': False, 'error': str(e)})
    else:
        send_message({'success': False, 'error': 'Unknown command or missing path'})


def main():
    """
    主循环：支持 connectNative 长连接模式
    - 短命令（ping, open, choose_dir 等）：同步执行，立即返回
    - 长命令（download_url）：在子线程中执行，主线程继续读取下一条消息
    - 当 stdin 关闭时（Chrome 断开连接），自动退出
    """
    while True:
        try:
            message = read_message()
        except SystemExit:
            raise
        except Exception:
            break

        command = message.get('command', '')
        # download_url 是长时间运行的任务，在子线程中执行，这样不会阻塞主循环
        # 子线程中通过 send_message 推送进度和完成消息
        if command == 'download_url':
            t = threading.Thread(target=handle_message, args=(message,), daemon=True)
            t.start()
        else:
            # 短命令同步执行
            handle_message(message)


if __name__ == '__main__':
    main()