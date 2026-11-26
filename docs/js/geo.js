(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var watchId = null;
  var messages = {
    denied: '位置情報が許可されていません。設定アプリで Safari／Chrome の位置情報を「許可」にしてください',
    unavailable: '現在地が見つかりません。空の見える場所で試すか、地図で場所を決めてください。',
    timeout: '現在地の確認に時間がかかっています。地図で場所を決めることもできます。',
    unsupported: 'この端末は位置情報に対応していません。地図で場所を決めてください。',
    failed: '現在地を確認できませんでした。地図で場所を決めてください。'
  };
  function errorKind(e) { return e && e.message === 'unsupported' ? 'unsupported' : e && e.code === 1 ? 'denied' : e && e.code === 2 ? 'unavailable' : e && (e.code === 3 || e.message === 'timeout') ? 'timeout' : 'failed'; }
  function errorMessage(e) { return messages[typeof e === 'string' ? e : errorKind(e)] || messages.failed; }
  function point(p) { return { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now(), src: 'gps' }; }
  function acquire(options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var geo = root.navigator && root.navigator.geolocation;
      if (!geo) { reject(new Error('unsupported')); return; }
      var best = null, done = false, id = null, timer, lastError;
      function finish(error) {
        if (done) return; done = true; root.clearTimeout(timer);
        if (id !== null) geo.clearWatch(id);
        if (best) resolve(best); else reject(error || lastError || new Error('timeout'));
      }
      timer = root.setTimeout(function () { finish(); }, options.maxMs || 8000);
      id = geo.watchPosition(function (p) {
        var next = point(p); if (!best || next.acc < best.acc) best = next;
        if (best.acc <= (options.goodAcc || 30)) finish();
      }, function (e) { lastError = e; if (e.code === 1) finish(e); }, { enableHighAccuracy: true, maximumAge: 0, timeout: options.maxMs || 8000 });
      if (done) geo.clearWatch(id);
    });
  }
  function stop() { if (watchId !== null) { root.navigator.geolocation.clearWatch(watchId); watchId = null; } }
  function watch(cb) {
    stop(); var geo = root.navigator && root.navigator.geolocation;
    if (!geo) { cb(null, { kind: 'unsupported', message: messages.unsupported }); return; }
    watchId = geo.watchPosition(function (p) { cb(point(p), null); }, function (e) { cb(null, { kind: errorKind(e), message: errorMessage(e) }); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    return stop;
  }
  root.SPM.geo = { acquire: acquire, watch: watch, stop: stop, errorKind: errorKind, errorMessage: errorMessage, messages: messages, distanceMeters: root.SPM.util.distanceMeters };
})(typeof window !== 'undefined' ? window : globalThis);
