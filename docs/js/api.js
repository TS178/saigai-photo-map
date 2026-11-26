(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  function getUrl() {
    var url = (root.SPM_CONFIG || {}).gasUrl || '';
    if (root.location && ['localhost', '127.0.0.1'].indexOf(root.location.hostname) >= 0) {
      try {
        var params = new URLSearchParams(root.location.search), override = params.get('api');
        if (override) { url = override; root.sessionStorage.setItem('spm-api', override); }
        else url = root.sessionStorage.getItem('spm-api') || url;
      } catch (e) { /* 保存できなくても通常の設定で続ける。 */ }
    }
    return url;
  }
  async function request(action, payload, options, ping) {
    var url = getUrl();
    if (!url) return { ok: false, error: 'config', message: '受付の接続先が設定されていません。管理担当の方は、手引き01の「最初の設定」を確認してください。' };
    var controller, timer;
    try {
      controller = new root.AbortController();
      timer = root.setTimeout(function () { controller.abort(); }, options && options.timeoutMs || (action === 'upload' ? 120000 : 30000));
      var init = { redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: controller.signal };
      if (ping) { url += (url.indexOf('?') >= 0 ? '&' : '?') + 'a=ping'; }
      else { init.method = 'POST'; init.body = JSON.stringify(Object.assign({}, payload || {}, { a: action })); }
      var response = await root.fetch(url, init), data;
      try { data = await response.json(); } catch (e) {
        if (controller.signal.aborted || e.name === 'AbortError' || e.name === 'TypeError') return { ok: false, error: 'network', message: '通信できませんでした' };
        return { ok: false, error: 'server', message: 'サーバーの返事を読み取れませんでした。公開の設定を確認してください。' };
      }
      if (!response.ok || !data || typeof data.ok !== 'boolean') return { ok: false, error: 'server', message: 'サーバーで問題が起きました。少し待ってからやり直してください。' };
      return data;
    } catch (e) { return { ok: false, error: 'network', message: '通信できませんでした' }; }
    finally { if (timer) root.clearTimeout(timer); }
  }
  function api(action, payload, options) { return request(action, payload, options, false); }
  api.ping = function (options) { return request('ping', {}, options, true); };
  api.getUrl = getUrl; api.api = api;
  api.pollSeconds = function (fallback) {
    if (root.location && ['localhost', '127.0.0.1'].indexOf(root.location.hostname) >= 0) { var n = Number(new URLSearchParams(root.location.search).get('poll')); if (n > 0 && Number.isFinite(n)) return n; }
    return fallback;
  };
  root.SPM.api = api;
})(typeof window !== 'undefined' ? window : globalThis);
