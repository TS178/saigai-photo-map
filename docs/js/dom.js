(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  function el(tag, attrs, children) {
    var node = root.document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (/^on/i.test(key)) throw new Error('イベントはaddEventListenerで登録してください。');
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'multiple') node[key] = !!value;
      else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    });
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach(function (child) {
      if (child !== null && child !== undefined) node.appendChild(typeof child === 'object' ? child : root.document.createTextNode(String(child)));
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function toast(msg) {
    var node = root.document.getElementById('toast');
    if (!node) { node = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); root.document.body.appendChild(node); }
    var header = root.document.querySelector('.admin-header, .app-header');
    node.style.setProperty('--toast-top', Math.max(0, header ? header.getBoundingClientRect().bottom : 0) + 'px');
    node.textContent = msg; node.hidden = false;
    root.clearTimeout(toast.timer); toast.timer = root.setTimeout(function () { node.hidden = true; }, 4000);
  }
  function banner(kind, msg, id) {
    id = id || 'banner'; var node = root.document.getElementById(id);
    if (!node) { node = el('div', { id: id, role: 'status', 'aria-live': 'polite' }); root.document.body.prepend(node); }
    node.className = 'banner ' + (['error', 'success', 'warning'].indexOf(kind) >= 0 ? kind : 'warning');
    node.textContent = msg || ''; node.hidden = !msg; return node;
  }
  root.SPM.dom = { el: el, clear: clear, toast: toast, banner: banner };
})(typeof window !== 'undefined' ? window : globalThis);
