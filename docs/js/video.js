(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var MB = 1024 * 1024, BLOCK = 256 * 1024;
  function formatDuration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
    var seconds = Math.floor(value);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }
  function progressText(size, next) {
    function mb(bytes) { return String(Math.round(bytes / MB * 10) / 10); }
    return '動画 ' + mb(size) + 'MB 中 ' + mb(next) + 'MB';
  }
  function validNext(next, size) { return Number.isSafeInteger(next) && next >= 0 && next <= size; }
  function chunkRange(size, next, chunkSize) {
    if (!Number.isSafeInteger(size) || size <= 0 || !validNext(next, size) || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize % BLOCK) throw new Error('動画の続きの位置を確認できませんでした。');
    return { start: next, end: Math.min(size, next + chunkSize) };
  }
  function mimeType(file) {
    var mime = String(file.type || '').toLowerCase().split(';')[0].trim();
    if (!mime || mime === 'application/octet-stream') {
      var ext = String(file.name || '').toLowerCase().split('.').pop();
      mime = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', m4v: 'video/x-m4v' }[ext] || '';
    }
    if (['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/x-m4v'].indexOf(mime) < 0) throw new Error('この動画の形式は送れません。MP4・MOV・WebM・3GP・M4Vの動画を選んでください。');
    return mime;
  }
  function waitFor(video, eventName, begin) {
    return new Promise(function (resolve, reject) {
      var timer = root.setTimeout(function () { finish(new Error('動画の画像を読み取れませんでした。')); }, 10000);
      function finish(error) {
        root.clearTimeout(timer); video.removeEventListener(eventName, ready); video.removeEventListener('error', failed);
        if (error) reject(error); else resolve();
      }
      function ready() { finish(); }
      function failed() { finish(new Error('動画の画像を読み取れませんでした。')); }
      video.addEventListener(eventName, ready); video.addEventListener('error', failed);
      try { begin(); } catch (e) { finish(e); }
    });
  }
  async function thumbnail(file) {
    var video = root.document.createElement('video'), canvas = root.document.createElement('canvas'), duration = null;
    var url = root.URL.createObjectURL(file), drawn = false;
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.setAttribute('playsinline', '');
    try {
      try {
        await waitFor(video, 'loadedmetadata', function () { video.src = url; video.load(); });
        if (Number.isFinite(video.duration) && video.duration >= 0) duration = video.duration;
        // metadataが読めても、画像の読み取りやseekは失敗することがある。
        await waitFor(video, 'seeked', function () { video.currentTime = duration === null ? 0.5 : Math.min(0.5, duration / 2); });
        var width = video.videoWidth, height = video.videoHeight;
        if (width && height) {
          var scale = Math.min(1, 320 / Math.max(width, height));
          canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height); drawn = true;
        }
      } catch (e) { /* 再生できない形式も、灰色の画像を付けて送れる。 */ }
      if (!drawn) {
        canvas.width = 320; canvas.height = 180;
        var ctx = canvas.getContext('2d'); ctx.fillStyle = '#e2e6eb'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('▶ 動画', 160, 90);
      }
      async function encode(quality) {
        var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
        if (!blob) throw new Error('動画のサムネイルを保存できませんでした。');
        return blob.arrayBuffer();
      }
      var thumb = await encode(0.7);
      if (4 * Math.ceil(thumb.byteLength / 3) > 45000) thumb = await encode(0.4);
      if (4 * Math.ceil(thumb.byteLength / 3) > 45000) throw new Error('動画のサムネイルが大きすぎます。');
      return { thumb: thumb, duration: duration };
    } finally { video.removeAttribute('src'); video.load(); root.URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
  }
  async function process(file, maxMB) {
    maxMB = typeof maxMB === 'number' && maxMB > 0 ? maxMB : 100;
    if (file.size > maxMB * MB) throw new Error('動画が大きすぎます（' + maxMB + 'MBまで）。短く撮り直してください（30秒くらいがおすすめ）');
    if (!file.size) throw new Error('動画の大きさを確認できません。別の動画を選んでください。');
    var mime = mimeType(file), preview = await thumbnail(file);
    return { kind: 'video', mime: mime, size: file.size, sizeMB: file.size / MB, duration: preview.duration, img: await file.arrayBuffer(), thumb: preview.thumb,
      shot: root.SPM.util.formatJst(new Date(file.lastModified || Date.now())), fileKey: JSON.stringify([file.name, file.size, file.lastModified]) };
  }
  function serverError() { return { ok: false, error: 'server', message: '動画の続きの位置を確認できませんでした。少し待ってから送り直します。' }; }
  function retryAction(reply) {
    // 届いたか分からない塊は再送せず、送信待ちから同じIDで位置を聞き直す。
    return !reply.ok && ['network', 'timeout', 'server', 'busy'].indexOf(reply.error) >= 0 ? 'videoStart' : null;
  }
  async function upload(record, token, onProgress) {
    var S = root.SPM, size = record.img.byteLength, recoveries = 0, stalled = 0;
    function progress(next) { if (onProgress) onProgress({ id: record.id, size: size, next: next, text: progressText(size, next) }); }
    function complete(reply) { return reply.ok && (reply.done === true || reply.dup === true); }
    // 初回・送り直し・ページを開き直した後も、必ず同じIDで位置を聞く。
    // record.videoNextは表示用。返事を失った塊の位置としては使わない。
    while (recoveries <= 3) {
      var data = { token: token, mime: record.mime, size: size, duration: record.duration, thumb: S.photo.toBase64(record.thumb) };
      ['id', 'pid', 'n', 'of', 'lat', 'lng', 'acc', 'src', 'shot', 'cat', 'urgent', 'note', 'who', 'org', 'ua'].forEach(function (key) { data[key] = record[key]; });
      var reply = await S.api('videoStart', data, { timeoutMs: 120000 });
      if (complete(reply)) { progress(size); return reply; }
      if (!reply.ok) { if (reply.error === 'restart') { recoveries++; continue; } return reply; }
      var next = reply.next, chunkSize = reply.chunkSize;
      try { chunkRange(size, next, chunkSize); } catch (e) { return serverError(); }
      progress(next);
      while (true) {
        if (root.navigator && root.navigator.onLine === false) return { ok: false, error: 'network', message: '電波が届きません' };
        // 全バイトの受領と、最後の記録の完了は別に扱う。
        if (next === size) { recoveries++; break; }
        var range = chunkRange(size, next, chunkSize);
        reply = await S.api('videoChunk', { token: token, id: record.id, start: range.start, data: S.photo.toBase64(record.img.slice(range.start, range.end)) }, { timeoutMs: 120000 });
        if (complete(reply)) { progress(size); return reply; }
        if (!reply.ok && reply.error === 'restart') { recoveries++; break; }
        if (!reply.ok && reply.error !== 'offset') return reply;
        if (!validNext(reply.next, size)) return serverError();
        if (reply.error === 'offset') { if (++recoveries > 3) return serverError(); }
        if (reply.next <= next) { if (++stalled > 3) return serverError(); } else stalled = 0;
        next = reply.next; progress(next);
      }
    }
    return serverError();
  }
  root.SPM.video = { process: process, upload: upload, retryAction: retryAction, formatDuration: formatDuration, progressText: progressText, validNext: validNext, chunkRange: chunkRange, mimeType: mimeType };
})(typeof window !== 'undefined' ? window : globalThis);
