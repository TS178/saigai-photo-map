(function (root) {
  'use strict';
  root.SPM_CONFIG = {
    appName: '災害写真マップ',
    gasUrl: 'https://script.google.com/macros/s/AKfycbx8EXxTcM4Ss5UWCid7q9SgpgHOWED8eVUS7tCdTRJU1PqphbMuZ4NTy80_rnyW5MFb/exec', // 公開したウェブアプリのURL（末尾が /exec）。試しの環境
    expectedGasVersion: '1.1.1',
    defaultMap: { lat: 36.2, lng: 138.25, zoom: 5 },
    tiles: {
      osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      photo: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
      gsiStd: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
