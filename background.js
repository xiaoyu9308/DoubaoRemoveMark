/**
 * 豆包去水印 - Background Service Worker
 * 
 * 处理：
 * 1. 右键菜单注册
 * 2. 图片下载
 * 3. 批量下载
 * 4. 下载目录管理
 */

// ── 在豆包页面加载时注入主世界脚本 ──────────────────────────────────────────
// 使用 chrome.scripting.executeScript + world: "MAIN" 比 manifest 的 world 字段更可靠
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && tab.url.includes('doubao.com')) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['injected.js'],
      world: 'MAIN',
      injectImmediately: true
    }).catch(() => {});
  }
});

// ── 默认下载目录 ──────────────────────────────────────────────────────────────
const DEFAULT_DOWNLOAD_DIR = '豆包无水印图片';

// ── 创建右键菜单 ──────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-no-watermark',
    title: '下载原图（无水印）',
    contexts: ['image'],
    documentUrlPatterns: ['https://*.doubao.com/*']
  });

  chrome.contextMenus.create({
    id: 'copy-no-watermark-url',
    title: '复制无水印图片链接',
    contexts: ['image'],
    documentUrlPatterns: ['https://*.doubao.com/*']
  });
});

// ── 右键菜单点击 ──────────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'download-no-watermark') {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_IMAGE_INFO' });
      let downloadUrl = null;

      if (response) {
        downloadUrl = response.image_ori_raw?.url || response.image_ori?.url || response.imageUrl;
      }

      if (!downloadUrl && info.srcUrl) {
        downloadUrl = convertToNoWatermarkUrl(info.srcUrl) || info.srcUrl;
      }

      if (downloadUrl) {
        await downloadImage(downloadUrl, tab.id);
      } else {
        showToastInTab(tab.id, '未找到无水印图片URL', 'error');
      }
    } catch (e) {
      if (info.srcUrl) {
        const url = convertToNoWatermarkUrl(info.srcUrl) || info.srcUrl;
        await downloadImage(url, tab.id);
      }
    }
  }

  if (info.menuItemId === 'copy-no-watermark-url') {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_IMAGE_INFO' });
      let url = null;
      if (response) {
        url = response.image_ori_raw?.url || response.image_ori?.url || response.imageUrl;
      }
      if (!url && info.srcUrl) {
        url = convertToNoWatermarkUrl(info.srcUrl) || info.srcUrl;
      }
      if (url) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (text) => { navigator.clipboard.writeText(text); },
          args: [url]
        });
        showToastInTab(tab.id, '无水印链接已复制', 'success');
      }
    } catch (e) {
      // 复制链接失败，静默
    }
  }
});

// ── URL转换：将带水印URL转为无水印URL ──────────────────────────────────────────
function convertToNoWatermarkUrl(url) {
  if (!url || !url.includes('byteimg.com')) return null;

  try {
    const patterns = [
      /(~tplv-[\w]+-)(downsize_watermark_\d+_\d+)(_[a-z]\.\w+)/,
      /(~tplv-[\w]+-)(pre_watermark)(_[a-z]\.\w+)/,
      /(~tplv-[\w]+-)(dld_watermark)(_[a-z]\.\w+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return url.replace(pattern, '$1image_raw$3');
      }
    }

    // 通用 watermark 替换
    if (url.includes('watermark')) {
      const newUrl = url.replace(/(~tplv-[\w]+-)[\w_]*watermark[\w_]*(_[a-z]\.\w+)/, '$1image_raw$2');
      if (newUrl !== url) return newUrl;
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ── 下载图片 ──────────────────────────────────────────────────────────────────
async function downloadImage(url, tabId, filename, customDir) {
  try {
    // 获取下载目录
    let downloadDir = customDir;
    if (!downloadDir) {
      const stored = await chrome.storage.local.get('downloadDir');
      downloadDir = stored.downloadDir || DEFAULT_DOWNLOAD_DIR;
    }

    // 生成文件名
    if (!filename) {
const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const ext = url.match(/\.(png|jpe?g|webp)/)?.[1] || 'png';
      filename = 'doubao_' + timestamp + '.' + ext;
    }

    const fullPath = downloadDir + '/' + filename;

    const downloadId = await chrome.downloads.download({
      url: url,
      filename: fullPath,
      saveAs: false,
      conflictAction: 'uniquify'
    });

    if (tabId) {
      showToastInTab(tabId, '无水印图片下载中...', 'success');
    }
  } catch (e) {
    if (tabId) {
      showToastInTab(tabId, '下载失败: ' + e.message, 'error');
    }
  }
}

// ── 批量下载 ──────────────────────────────────────────────────────────────────
async function batchDownload(urls, tabId, customDir) {
  let downloadDir = customDir;
  if (!downloadDir) {
    const stored = await chrome.storage.local.get('downloadDir');
    downloadDir = stored.downloadDir || DEFAULT_DOWNLOAD_DIR;
  }

  let success = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const url = urls[i].url || urls[i];
const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const ext = url.match(/\.(png|jpe?g|webp)/)?.[1] || 'png';
      const filename = 'doubao_' + timestamp + '.' + ext;
      await downloadImage(url, null, filename, downloadDir);
      success++;
      // 间隔500ms避免下载太快
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      // 单张下载失败，继续下一张
    }
  }
  if (tabId) {
    showToastInTab(tabId, '批量下载完成：' + success + '/' + urls.length, success === urls.length ? 'success' : 'info');
  }
}

// ── 在页面中显示Toast ─────────────────────────────────────────────────────────
function showToastInTab(tabId, message, type) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (msg, t) => {
      const colors = {
        info: { bg: '#e6f7ff', border: '#1890ff', color: '#1890ff' },
        success: { bg: '#f6ffed', border: '#52c41a', color: '#52c41a' },
        error: { bg: '#fff2f0', border: '#ff4d4f', color: '#ff4d4f' },
      };
      const c = colors[t] || colors.info;
      const toast = document.createElement('div');
      toast.textContent = msg;
      toast.style.cssText = 'position:fixed;top:40%;left:50%;transform:translateX(-50%);background:' + c.bg + ';color:' + c.color + ';padding:12px 24px;border:1px solid ' + c.border + ';border-radius:8px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity 0.3s ease;pointer-events:none;';
      document.body.appendChild(toast);
      setTimeout(function() {
        toast.style.opacity = '0';
        setTimeout(function() { toast.remove(); }, 300);
      }, 3000);
    },
    args: [message, type]
  });
}

// ── popup 长连接：通过 Port 直接转发下载进度，避免 sendMessage 的注册/查找开销 ──
// popup 打开时会 chrome.runtime.connect({ name: 'download-progress' }) 与本 SW 建立长连接，
// 本 SW 把当前活跃的 Port 缓存下来，下载进度消息直接走 Port.postMessage 推送给 popup。
// 多个 popup 实例（极少见）都会被加入集合，全部广播。
const popupPorts = new Set();
// 缓存最近一次 download_complete 消息：popup 关闭后可能重开，但 SW 已经收到了完成消息，
// 这种情况下需要在新 popup 连接时立刻补发，避免下载已完成但 popup 还显示 "下载中..."
let lastCompleteSnapshot = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'download-progress') return;
  popupPorts.add(port);
  // 如果有未消费的完成消息，立刻补发
  if (lastCompleteSnapshot) {
    try { port.postMessage(lastCompleteSnapshot); } catch (e) { /* ignore */ }
    lastCompleteSnapshot = null;
  }
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});

function postToPopup(msg) {
  // 向所有活跃 popup Port 广播
  if (popupPorts.size === 0) return false;
  let delivered = false;
  for (const p of popupPorts) {
    try {
      p.postMessage(msg);
      delivered = true;
    } catch (e) {
      // 单个 port 异常忽略，不影响其他
    }
  }
  return delivered;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'DOWNLOAD_IMAGE':
      downloadImage(message.url, sender.tab?.id, message.filename, message.downloadDir);
      sendResponse({ success: true });
      break;

    case 'BATCH_DOWNLOAD':
      batchDownload(message.urls, sender.tab?.id, message.downloadDir);
      sendResponse({ success: true });
      break;

    case 'FETCH_IMAGE':
      // 代理获取图片数据（避免 popup 中的 CORS 限制）
      fetchImageData(message.url)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // 异步响应

    case 'GET_DOWNLOAD_DIR':
      // 获取 Chrome 默认下载目录的绝对路径
      getDownloadDir()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'OPEN_DIRECTORY':
      // 在文件管理器中打开指定目录
      openDirectory(message.path)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'CHOOSE_DIRECTORY':
      // 通过 native host 弹出 macOS 原生选择目录对话框，返回绝对路径
      chooseDirectory(message.defaultLocation)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'DOWNLOAD_URL_NATIVE':
      // 通过 native host 长连接（connectNative）直接用 Python 下载 URL 写入磁盘
      // 使用长连接，native host 每完成一张图片就推送 download_progress 消息，
      // background 收到后转发给 popup 实时刷新进度，无需轮询
      downloadUrlNativeWithProgress(message.dir, message.items, sendResponse);
      return true; // 异步响应

    case 'WRITE_FILE_NATIVE':
      // 通过 native host 把 base64 内容写入指定绝对路径下的文件
      writeFileNative(message.dir, message.filename, message.dataBase64)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'TEST_NATIVE_PING':
      // 诊断：测试 Native Messaging 是否可用，返回 Python 环境信息
      testNativePing()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
  }
  return true;
});

// ── 获取图片数据（返回 base64）──────────────────────────────────────────────
async function fetchImageData(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'image/*'
      }
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const blob = await response.blob();

    // 用 FileReader.readAsDataURL 高效转换，避免手动分块拼接导致调用栈溢出
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });

    // 从 data URL 中提取纯 base64 数据（去掉 "data:image/xxx;base64," 前缀）
    const base64 = dataUrl.split(',', 2)[1];

    return { success: true, data: base64 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 获取 Chrome 默认下载目录的绝对路径 ────────────────────────────────────
async function getDownloadDir() {
  try {
    // 搜索最近的下载记录来推断下载目录
    const downloads = await chrome.downloads.search({
      limit: 1,
      orderBy: ['-startTime']
    });
    
    if (downloads && downloads.length > 0 && downloads[0].filename) {
      const filePath = downloads[0].filename;
      const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSep > 0) {
        return { success: true, path: filePath.substring(0, lastSep) };
      }
    }

    // 没有下载记录，创建一个极小的临时文件来探测路径
    const tempUrl = 'data:text/plain;base64,';
    const downloadId = await chrome.downloads.download({
      url: tempUrl,
      filename: '_doubao_probe_.tmp',
      saveAs: false,
      conflictAction: 'uniquify'
    });
    
    // 等待下载完成
    await new Promise(resolve => {
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      setTimeout(resolve, 2000);
    });

    const probeDownloads = await chrome.downloads.search({ id: downloadId });
    let downloadDir = '';
    if (probeDownloads && probeDownloads.length > 0 && probeDownloads[0].filename) {
      const filePath = probeDownloads[0].filename;
      const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSep > 0) {
        downloadDir = filePath.substring(0, lastSep);
      }
    }
    // 清理临时文件
    try { await chrome.downloads.removeFile(downloadId); } catch (e) {}
    try { await chrome.downloads.erase({ id: downloadId }); } catch (e) {}

    return { success: true, path: downloadDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 在文件管理器中打开指定目录 ────────────────────────────────────────────
async function openDirectory(dirPath) {
  const result = await chrome.runtime.sendNativeMessage(
    'com.doubao.remove.mark',
    { command: 'open', path: dirPath }
  );
  if (result && result.success) {
    return { success: true };
  }
  return { success: false, error: result?.error || 'Native Messaging 返回失败' };
}

// ── 通过 native host 弹出 macOS 原生选择目录对话框 ─────────
async function chooseDirectory(defaultLocation) {
  try {
    const result = await chrome.runtime.sendNativeMessage(
      'com.doubao.remove.mark',
      { command: 'choose_dir', prompt: '请选择下载目录', default_location: defaultLocation || '' }
    );
    return result || { success: false, error: 'Native Messaging 无响应' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 通过 native host 长连接下载 URL，实时接收进度回调 ──
// 进度消息走 popup Port (postToPopup) 而非 sendMessage：
//   1. Port 是已建立的长连接，省去 sendMessage 每次注册接收方/查找的开销
//   2. 消息更紧凑、延迟更低、顺序更稳
//   3. 如果 popup 关闭，postToPopup 静默丢弃，不会阻塞 native host 推送
function downloadUrlNativeWithProgress(dir, items, sendResponse) {
  try {
    const port = chrome.runtime.connectNative('com.doubao.remove.mark');
    let downloadFinished = false; // 标记下载是否已完成（正常或异常），防止 onDisconnect 误报错误

    port.onMessage.addListener((msg) => {
      if (msg.type === 'download_progress') {
        // 每完成一张图片，native host 推送进度消息
        // 通过 popup Port 直接转发，最低延迟
        postToPopup({
          type: 'DOWNLOAD_PROGRESS_UPDATE',
          completed: msg.completed,
          total: msg.total,
          success: msg.success,
          fail: msg.fail,
          filename: msg.filename,
          itemSuccess: msg.item_success,
          itemError: msg.item_error,
        });
      } else if (msg.type === 'download_complete') {
        // 全部下载完成
        downloadFinished = true;
        const completeMsg = {
          type: 'DOWNLOAD_COMPLETE',
          successCount: msg.success_count,
          failCount: msg.fail_count,
          results: msg.results,
        };
        // 优先走 Port 推送；如果当前没有活跃 popup（popup 已关闭），则缓存供下次重连补发
        const delivered = postToPopup(completeMsg);
        if (!delivered) {
          lastCompleteSnapshot = completeMsg;
        }
        // 长连接任务完成，断开连接
        port.disconnect();
      } else if (msg.success === false && msg.error) {
        // 错误消息（如目录不存在等）
        downloadFinished = true;
        postToPopup({
          type: 'DOWNLOAD_ERROR',
          error: msg.error,
        });
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      // 如果 downloadFinished 为 true，说明是正常完成后的断开（我们主动 disconnect），
      // 此时 Python 进程已退出，Chrome 报 "Native host has exited" 是正常的，不算错误
      if (downloadFinished) {
        return;
      }
      if (err) {
        postToPopup({
          type: 'DOWNLOAD_ERROR',
          error: err.message,
        });
      }
    });

    // 发送下载命令
    port.postMessage({ command: 'download_url', dir: dir, items: items });

    // 立即响应 popup：下载已启动
    sendResponse({ success: true, message: '下载已在后台启动' });

  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// ── 通过 native host 写文件（base64 -> 任意绝对路径）───────────
async function writeFileNative(dir, filename, dataBase64) {
  try {
    const result = await chrome.runtime.sendNativeMessage(
      'com.doubao.remove.mark',
      { command: 'write_file', dir: dir, filename: filename, data_base64: dataBase64 }
    );
    return result || { success: false, error: 'Native Messaging 无响应' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 诊断：测试 Native Messaging 是否可用 ──────────────────────
async function testNativePing() {
  try {
    const result = await chrome.runtime.sendNativeMessage(
      'com.doubao.remove.mark',
      { command: 'ping' }
    );
    return { success: true, info: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
