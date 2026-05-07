/**
 * 豆包去水印 - 注入到页面主世界的脚本
 * 
 * 此文件通过 manifest.json 的 world: "MAIN" 配置直接运行在页面主世界中，
 * 可以访问页面原始的 JSON.parse 等对象，绕过 CSP 限制。
 * 
 * 核心原理：Hook JSON.parse，拦截豆包后端返回的SSE stream数据，
 * 提取 creations 数组中的无水印原图URL（image_ori_raw.url）
 */

(function () {
  'use strict';

  // ── 递归查找JSON中所有指定key的值 ──
  function findAllKeysInJson(obj, key) {
    var results = [];
    function search(current) {
      if (current && typeof current === 'object') {
        if (!Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, key)) {
          results.push(current[key]);
        }
        var items = Array.isArray(current) ? current : Object.values(current);
        for (var i = 0; i < items.length; i++) {
          search(items[i]);
        }
      }
    }
    search(obj);
    return results;
  }

  // ── 从 creations 数组中提取无水印图片URL ──
  function extractImagesFromCreations(creations) {
    if (!Array.isArray(creations)) return [];
    var images = [];
    for (var i = 0; i < creations.length; i++) {
      var item = creations[i];
      try {
        if (item && item.image) {
          var imgData = {
            // 优先使用无水印原图
            image_ori_raw_url: (item.image.image_ori_raw && item.image.image_ori_raw.url) || null,
            image_ori_url: (item.image.image_ori && item.image.image_ori.url) || null,
            image_preview_url: (item.image.image_preview && item.image.image_preview.url) || null,
            image_thumb_url: (item.image.image_thumb && item.image.image_thumb.url) || null,
          };
          images.push(imgData);
        }
      } catch (e) {
        console.error('[豆包去水印] 提取 creation 项时出错:', e);
      }
    }
    return images;
  }

  // ── Hook JSON.parse ──
  var _parse = JSON.parse;
  JSON.parse = function (text, reviver) {
    var jsonData = _parse.call(this, text, reviver);

    // 只处理包含 creations 的数据
    if (typeof text === 'string' && text.includes('creations')) {
      try {
        var creationsList = findAllKeysInJson(jsonData, 'creations');
        if (creationsList.length > 0) {
          var allImages = [];
          creationsList.forEach(function (creations) {
            var imgs = extractImagesFromCreations(creations);
            allImages = allImages.concat(imgs);
          });
          if (allImages.length > 0) {
            console.log('[豆包去水印] 提取到', allImages.length, '张图片数据');
            // 通知 content script（隔离世界之间通过 postMessage 通信）
            window.postMessage({
              type: 'DOUBAO_NOWATERMARK_IMAGES',
              images: allImages
            }, '*');
          }
        }
      } catch (e) {
        console.error('[豆包去水印] 处理数据时出错:', e);
      }
    }

    return jsonData;
  };

  console.log('[豆包去水印] JSON.parse 已在页面主世界中被 Hook');
})();
