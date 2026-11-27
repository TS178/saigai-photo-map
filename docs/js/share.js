(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var dom = root.SPM.dom, el = dom.el, mediaActive = 0, mediaWaiting = [];
  function postLink(pageUrl, code, includeCode) {
    var url = new root.URL(pageUrl);
    if (url.protocol !== 'https:') throw new Error('https://で始まる投稿ページのリンクを入れてください。');
    url.searchParams.set('openExternalBrowser', '1');
    url.hash = includeCode && code ? 'k=' + encodeURIComponent(root.SPM.util.normCode(code)) : '';
    return url.href;
  }
  function drawQr(canvas, value, size) {
    var qr = root.qrcode(0, 'M');
    // 日本語の災害名などを含むURLもUTF-8のバイトとして渡す。
    qr.addData(value); qr.make();
    var count = qr.getModuleCount(), quiet = 4, scale = Math.max(1, Math.floor((size || 280) / (count + quiet * 2)));
    canvas.width = canvas.height = (count + quiet * 2) * scale;
    var context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    for (var r = 0; r < count; r++) for (var c = 0; c < count; c++) if (qr.isDark(r, c)) context.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'リンクのQRコード');
    return canvas;
  }
  function download(blob, name) {
    var url = root.URL.createObjectURL(blob), link = el('a', { href: url, download: name, hidden: true });
    root.document.body.appendChild(link); link.click(); link.remove();
    root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 60000);
  }
  function mediaBytes(b64) {
    var binary = root.atob(b64), data = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return data;
  }
  function mediaSlot() {
    return new Promise(function (resolve) {
      function enter() {
        mediaActive++;
        resolve(function () { mediaActive--; var next = mediaWaiting.shift(); if (next) next(); });
      }
      if (mediaActive < 2) enter(); else mediaWaiting.push(enter);
    });
  }
  // 最初の応答で全体の大きさを確かめ、以後は8MBずつ、同時に2件まで。
  async function loadMedia(d, id, onProgress, cancelled) {
    var block = 8 * 1024 * 1024, total, mime, loaded = 0, parts = [];
    function stopped() { return cancelled && cancelled(); }
    async function part(start) {
      if (stopped()) return;
      var release = await mediaSlot(), reply;
      try {
        if (stopped()) return;
        reply = await root.SPM.admin.request('media', { d: d, id: id, start: start, length: block }, { timeoutMs: 120000 });
      } finally { release(); }
      if (stopped()) return;
      if (!reply.ok) throw new Error(reply.message || '動画を読み込めませんでした。');
      if (!Number.isSafeInteger(reply.total) || reply.total <= 0 || !/^video\//.test(reply.mime || '')) throw new Error('動画の大きさや形式を確認できませんでした。');
      if (total === undefined) { total = reply.total; mime = reply.mime; }
      if (reply.total !== total || reply.mime !== mime) throw new Error('動画が変わりました。もう一度開いてください。');
      var data = mediaBytes(reply.b64);
      if (data.length !== Math.min(block, total - start)) throw new Error('動画を最後まで読み込めませんでした。');
      parts[start / block] = data; loaded += data.length;
      if (onProgress) onProgress({ total: total, loaded: loaded, text: '動画を読み込み中 ' + Math.round(total / 1048576 * 10) / 10 + 'MB 中 ' + Math.round(loaded / 1048576 * 10) / 10 + 'MB' });
    }
    await part(0);
    for (var start = block; !stopped() && start < total; start += block * 2) {
      await Promise.all([part(start), start + block < total ? part(start + block) : Promise.resolve()]);
    }
    return stopped() ? null : new Blob(parts, { type: mime });
  }
  function saveQr(canvas, name) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (!blob) { reject(new Error('QRの画像を保存できませんでした。')); return; } download(blob, name || '投稿用QR.png'); resolve(); }, 'image/png');
    });
  }
  function createPanel(pageUrl, code) {
    var box = el('section', { class: 'stack share-panel' }), include = el('input', { type: 'checkbox', checked: !!code }), input = el('input', { type: 'text', readonly: true, 'aria-label': '投稿用リンク' });
    var link = el('a', { target: '_blank', rel: 'noopener', text: '投稿ページを開く' }), canvas = el('canvas'), warning = el('p', { class: 'banner warning' }), error = el('p', { class: 'error', role: 'status' });
    var copy = el('button', { type: 'button', text: 'リンクをコピー' }), save = el('button', { type: 'button', text: 'QRの画像を保存' });
    function update() {
      try {
        input.value = postLink(pageUrl, code, include.checked); link.href = input.value;
        drawQr(canvas, input.value); error.textContent = ''; copy.disabled = save.disabled = false;
        warning.textContent = include.checked ? 'このリンク・QRには合言葉が入っています。職員・消防団の外に出さないでください。' : '合言葉なしのリンク・QRです。投稿するときに合言葉の入力が必要です。';
      } catch (e) { input.value = ''; link.removeAttribute('href'); canvas.width = canvas.height = 0; error.textContent = e.message; copy.disabled = save.disabled = true; }
    }
    include.disabled = !code; include.addEventListener('change', update);
    copy.addEventListener('click', async function () {
      try { await root.navigator.clipboard.writeText(input.value); dom.toast('リンクをコピーしました。'); }
      catch (e) { input.focus(); input.select(); dom.toast('コピーできませんでした。選択されたリンクをCtrl+Cでコピーしてください。'); }
    });
    save.addEventListener('click', async function () { try { await saveQr(canvas); } catch (e) { error.textContent = e.message; } });
    box.append(el('h3', { text: '投稿用リンクとQR' }), el('label', { class: 'check-label' }, [include, '合言葉入り（外すと合言葉なし）']), input, link, warning, canvas, el('div', { class: 'row' }, [copy, save]), error, el('small', { text: 'QRコードは株式会社デンソーウェーブの登録商標です。' }));
    if (!code) box.appendChild(el('p', { text: '現在の合言葉を確認するには、パスワードでログインし直してください。' }));
    update(); return box;
  }
  root.SPM.share = { postLink: postLink, drawQr: drawQr, saveQr: saveQr, download: download, createPanel: createPanel, loadMedia: loadMedia };
})(typeof window !== 'undefined' ? window : globalThis);
