/* ==========================================================================
   content.js —— 页面标注工具（Chrome / Edge MV3 扩展）

   干什么：页面上挂一个悬浮球，点开面板，点任意元素写意见，复制 Markdown。

   三个关键设计决定（都是踩过坑之后的最简解）：

   1. 不自造跨 iframe 协议。
      很多原型是 shell + iframe 架构，要标的元素在 iframe 里。但扩展的
      content script 在**每个 frame 各自独立注入**，而 chrome.storage 是
      **全局共享**的。所以：每个 frame 写自己的 key、读自己的 key，
      面板把所有 key 汇总显示。零 postMessage，零同步代码。
      （原实现为此造了双向 postMessage 协议，是纯粹的复杂度。）

   2. 钉子用文档坐标 + position:absolute。
      早期版本存视口坐标 clientX/clientY 并用 position:fixed 渲染，
      结果用户滚动后刷新页面，钉子就错位了——视口坐标不是持久坐标。
      现在存 clientX + scrollX（文档坐标），用 absolute 定位挂在文档流里，
      滚动和刷新都不需要重算，也不需要 scroll 监听。

   3. 标注模式的跨 frame 同步也走 storage。
      顶层点「开始标注」，iframe 里的引擎要一起开。写一个 pa:mode 标志，
      各 frame 监听 storage.onChanged。顶层每次加载时把它重置为 false，
      避免用户上次忘了关、下次打开页面所有点击都被标注吃掉。

   权限只需要 storage：content_scripts 是声明式注入，不需要 activeTab
   或 scripting；扩展全程不碰网络、不读页面内容之外的东西。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var NS = 'data-pa';            // 标记工具自己的 DOM，用来排除「标注到自己」
  var PIN_PREFIX = 'pa:pins:';   // 每个 frame 一个桶：pa:pins:/p05/code.html
  var MODE_KEY = 'pa:mode';      // 跨 frame 的开关标志
  var IS_TOP = window === window.top;

  /* 本 frame 的页面标识。用 pathname + query，去掉末尾 index.html，
     这样 /a/ 和 /a/index.html 视为同一页。 */
  var PAGE_KEY = (location.pathname + location.search || '/').replace(/\/index\.html?$/, '/');

  /* ---------------- 存储 ----------------
     直接用 chrome.storage，不再包一层 store.js —— 之前那层 7 个 API
     里只有 get/set 被调用，其余是死代码。
     Chrome 96+ 的 storage API 原生返回 Promise，不需要 callback 包装。 */
  var store = chrome.storage.local;

  function getPins(key) {
    return store.get(PIN_PREFIX + key).then(function (r) {
      return r[PIN_PREFIX + key] || [];
    });
  }
  function setPins(key, pins) {
    return store.set({ [PIN_PREFIX + key]: pins });
  }
  /** 读全部桶，返回 { 页面key: pins[] }，供面板汇总与导出。 */
  function allPins() {
    return store.get(null).then(function (r) {
      var out = {};
      Object.keys(r).forEach(function (k) {
        if (k.indexOf(PIN_PREFIX) === 0) out[k.slice(PIN_PREFIX.length)] = r[k] || [];
      });
      return out;
    });
  }

  /* ---------------- 元素描述 ----------------
     把「我标了哪个元素」变成人能读、能定位的三段信息：
       target      标签 + 前 3 个 class，如 button.btn-primary
       textSnippet 元素内前 40 字文字，给人看这是啥
       cssPath     往上 4 层的路径，给人能照着找
     密码框 / 标记了 data-sensitive 的元素不取原文，避免把敏感内容写进
     导出文件。 */
  var SKIP_CLASS = ['dark:', 'hover:', 'focus:', 'active:', 'group-hover:'];
  var SENSITIVE_SEL = 'input[type="password"], input[type="tel"]';

  function classesOf(el) {
    return (el.getAttribute('class') || '').split(/\s+/)
      .filter(function (c) { return c && !SKIP_CLASS.some(function (p) { return c.indexOf(p) === 0; }); })
      .slice(0, 3).join('.');
  }
  function isSensitive(el) {
    try {
      return el.matches(SENSITIVE_SEL) || !!el.closest('[data-sensitive]');
    } catch (e) { return false; }
  }
  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var cls = classesOf(el);
    var node = el, parts = [];
    while (node && parts.length < 4) {           // 往上取 4 层，遇到 body/html 停
      var t = node.tagName.toLowerCase();
      if (t === 'body' || t === 'html') break;
      var c = classesOf(node);
      parts.unshift(c ? t + '.' + c : t);
      node = node.parentElement;
    }
    return {
      target: cls ? tag + '.' + cls : tag,
      textSnippet: isSensitive(el)
        ? '（敏感内容已隐藏）'
        : (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      cssPath: parts.join(' > ')
    };
  }

  /* ---------------- 标注数据 ----------------
     一个内存数组就是全部状态。没有引擎类、没有 hydrate、没有回调。
     增删改三处直接操作数组后调 paint() 重画。 */
  var pins = [];
  var seq = 0;
  var on = false;        // 标注模式是否开启
  var ui = null;         // 顶层文档的面板引用，iframe 里为 null

  function addPin(el, x, y) {
    var d = describe(el);
    pins.push({
      id: 'p' + Date.now().toString(36) + (seq++).toString(36),
      target: d.target,
      textSnippet: d.textSnippet,
      cssPath: d.cssPath,
      comment: '',
      x: x, y: y        // 文档坐标（点击点 + 滚动量）
    });
    writePins();
    paint();
  }

  /* 面板里可能显示别的 frame 的标注（iframe 的 pin 在 iframe 那个桶里）。
     所以改意见 / 删标注必须**按桶路由**，不能只改本 frame 的 pins——
     这是之前版本「打字没反应」的真实原因：改了顶层数组，写回的是顶层桶。 */
  function editPin(bucket, id, fn) {
    getPins(bucket).then(function (list) {
      var next = list.map(function (p) { if (p.id === id) fn(p); return p; });
      rememberWrite(bucket, next);
      // 本 frame 自己的桶顺手同步内存与钉子
      if (bucket === PAGE_KEY) {
        pins = next;
        paintPins();
      }
    });
  }
  function removePin(bucket, id) {
    getPins(bucket).then(function (list) {
      var next = list.filter(function (p) { return p.id !== id; });
      rememberWrite(bucket, next);
      if (bucket === PAGE_KEY) { pins = next; paintPins(); }
      if (ui) ui.list();
    });
  }
  function setComment(bucket, id, text) {
    editPin(bucket, id, function (p) { p.comment = text; });
  }

  /* 记录「本 frame 刚写过哪些桶、各自写成什么」，用于 onChanged 里识别
     自己触发的变更，避免打字时重建列表导致光标失焦。按完整存储 key 记，
     因为面板可能正在编辑别的 frame（iframe）的标注。 */
  var selfWrites = {};
  function rememberWrite(bucket, list) {
    selfWrites[PIN_PREFIX + bucket] = JSON.stringify(list);
    setPins(bucket, list);
  }
  function writePins() {
    rememberWrite(PAGE_KEY, pins);
  }

  /* ---------------- 样式 ----------------
     全部内联、全 pa- 前缀，不依赖页面有没有加载 Tailwind 或任何 CSS。
     z-index 拉满，钉子和面板要盖在页面所有内容之上。 */
  var CSS =
    '.pa-panel{position:fixed;top:84px;right:18px;width:330px;max-height:calc(100vh - 120px);' +
    'display:none;flex-direction:column;background:#fff;border:1px solid #e2e8f0;border-radius:12px;' +
    'box-shadow:0 10px 30px rgba(15,23,42,.16);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",' +
    '"PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a;z-index:2147483647;overflow:hidden}' +
    '.pa-panel.on{display:flex}' +
    '.pa-hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eef2f7}' +
    '.pa-hd b{font-weight:500;flex:1}' +
    '.pa-n{background:#eff6ff;color:#2563eb;border-radius:20px;padding:1px 9px;font-size:12px}' +
    '.pa-ic{border:1px solid #e2e8f0;background:#fff;border-radius:7px;width:26px;height:26px;display:grid;' +
    'place-items:center;cursor:pointer;color:#64748b}' +
    '.pa-ic:hover{background:#f8fafc;color:#0f172a}' +
    '.pa-bar{padding:10px 14px;border-bottom:1px solid #eef2f7}' +
    '.pa-go{width:100%;border:0;border-radius:8px;padding:9px;cursor:pointer;font:500 13px inherit;' +
    'background:#2563eb;color:#fff}' +
    '.pa-go.on{background:#dc2626}' +
    '.pa-list{flex:1;overflow-y:auto;padding:8px}' +
    '.pa-grp{font:500 11px/1.6 ui-monospace,Menlo,monospace;color:#94a3b8;padding:8px 4px 4px;' +
    'word-break:break-all}' +
    '.pa-item{border:1px solid #e8edf3;border-radius:9px;padding:9px 10px;margin-bottom:7px;background:#fcfdff}' +
    '.pa-meta{display:flex;align-items:baseline;gap:6px;margin-bottom:5px}' +
    '.pa-tag{background:#2563eb;color:#fff;border-radius:5px;padding:0 6px;font:500 11px/1.7 inherit;flex:0 0 auto}' +
    '.pa-path{font:11px/1.5 ui-monospace,Menlo,monospace;color:#64748b;word-break:break-all}' +
    '.pa-item textarea{width:100%;box-sizing:border-box;border:1px solid #dfe6ee;border-radius:6px;padding:6px 8px;' +
    'font:12.5px/1.6 inherit;resize:vertical;min-height:48px;color:#0f172a}' +
    '.pa-item textarea:focus{outline:none;border-color:#93b4f5}' +
    '.pa-del{border:0;background:none;color:#94a3b8;cursor:pointer;font-size:12px;padding:2px 4px}' +
    '.pa-del:hover{color:#dc2626}' +
    '.pa-ft{border-top:1px solid #eef2f7;padding:9px 14px}' +
    '.pa-exp{width:100%;border:0;border-radius:8px;padding:9px;cursor:pointer;font:500 13px inherit;' +
    'background:#059669;color:#fff}' +
    '.pa-fab{position:fixed;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%;border:0;' +
    'background:#2563eb;color:#fff;cursor:pointer;box-shadow:0 5px 16px rgba(37,99,235,.34);display:grid;' +
    'place-items:center;z-index:2147483647}' +
    '.pa-fab.hide{display:none}' +
    '.pa-pin{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;background:#2563eb;' +
    'color:#fff;border:2px solid #fff;box-shadow:0 2px 7px rgba(37,99,235,.4);font:500 12px/1 sans-serif;' +
    'display:grid;place-items:center;pointer-events:none;z-index:2147483646}' +
    '.pa-hl{position:absolute;display:none;border:2px solid #2563eb;background:rgba(37,99,235,.09);' +
    'border-radius:2px;pointer-events:none;z-index:2147483645}' +
    '.pa-hint{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;background:rgba(15,23,42,.9);' +
    'color:#fff;padding:7px 14px;border-radius:20px;font-size:12px;display:none;z-index:2147483647}' +
    '.pa-hint.on{display:block}' +
    '.pa-empty{text-align:center;color:#94a3b8;padding:30px 14px;font-size:12.5px}';

  function injectStyle() {
    if (document.getElementById('pa-style')) return;
    var s = document.createElement('style');
    s.id = 'pa-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    n.className = cls;
    n.setAttribute(NS, '');
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var ICON = {
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    down: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>'
  };
  function svg(n) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">' +
      ICON[n] + '</svg>';
  }

  /* ---------------- 页面上的图层：钉子 + 悬停高亮 ----------------
     每个 frame 各自持有一份，画在自己文档里。坐标是文档坐标，
     容器用 absolute 挂在文档流上，所以**不需要任何滚动或 resize 监听**。 */
  var layer = null, hl = null, pinNodes = {};

  function ensureLayer() {
    injectStyle();
    if (layer && layer.isConnected) return;
    layer = el('div');
    layer.style.cssText = 'position:absolute;inset:0;z-index:2147483646;pointer-events:none';
    document.body.appendChild(layer);

    hl = el('div', 'pa-hl');
    layer.appendChild(hl);
  }

  /** 重画本 frame 的钉子。只按 id 增删，不整体重建，避免闪烁。 */
  function paintPins() {
    ensureLayer();
    var live = {};
    pins.forEach(function (p, i) {
      live[p.id] = true;
      var n = pinNodes[p.id];
      if (!n) {
        n = el('div', 'pa-pin', String(i + 1));
        pinNodes[p.id] = n;
        layer.appendChild(n);
      }
      n.style.left = p.x + 'px';
      n.style.top = p.y + 'px';
    });
    Object.keys(pinNodes).forEach(function (id) {
      if (live[id]) return;
      if (pinNodes[id].parentNode) pinNodes[id].parentNode.removeChild(pinNodes[id]);
      delete pinNodes[id];
    });
  }

  /** 悬停高亮：告诉用户「现在点下去会标到哪个元素」。 */
  function showHover(rect) {
    ensureLayer();
    if (!rect) { hl.style.display = 'none'; return; }
    hl.style.display = 'block';
    hl.style.left = (rect.left + scrollX - 2) + 'px';
    hl.style.top = (rect.top + scrollY - 2) + 'px';
    hl.style.width = (rect.width + 4) + 'px';
    hl.style.height = (rect.height + 4) + 'px';
  }

  /** 模式开关或数据变化后，重画页面上的一切。 */
  function paint() {
    paintPins();
    if (ui) ui.list();
  }

  /* ---------------- 标注模式 ----------------
     broadcast=false 用于「跟随其他 frame 开关」——只改本地状态不回写，
     否则会和其他 frame 的 onChanged 形成回环。 */
  function setMode(next, broadcast) {
    on = next;
    if (next) {
      // 捕获阶段监听，先于页面自己的脚本拿到点击，把这次点击吃掉
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      showHover(null);
    }
    if (broadcast !== false) store.set({ [MODE_KEY]: next });   // 通知其他 frame
    if (ui) ui.syncBtn();
    var h = document.querySelector('.pa-hint');
    if (h) h.classList.toggle('on', next);
  }

  function onMove(e) {
    // 按住 Alt 临时让页面按原样响应，方便先操作页面再标注
    if (e.altKey) { showHover(null); return; }
    var t = e.target;
    if (!t || t.nodeType !== 1 || t.closest('[' + NS + ']')) { showHover(null); return; }
    showHover(t.getBoundingClientRect());
  }

  function onClick(e) {
    if (!on || e.altKey) return;
    if (e.target && e.target.nodeType === 1 && e.target.closest('[' + NS + ']')) return;
    e.preventDefault();
    e.stopPropagation();
    addPin(e.target.nodeType === 1 ? e.target : document.body, e.clientX + scrollX, e.clientY + scrollY);
  }

  /* ---------------- 面板（只在顶层文档建） ---------------- */
  function buildPanel() {
    injectStyle();

    var fab = el('button', 'pa-fab', svg('pen'));
    fab.title = '页面标注';
    fab.addEventListener('click', function (e) { e.stopPropagation(); ui.toggle(); });

    var panel = el('aside', 'pa-panel');
    panel.innerHTML =
      '<div class="pa-hd"><b>页面标注</b><span class="pa-n" data-n>0</span>' +
      '<button class="pa-ic" data-clear title="清空本页标注">' + svg('trash') + '</button>' +
      '<button class="pa-ic" data-close title="收起">' + svg('x') + '</button></div>' +
      '<div class="pa-bar"><button class="pa-go" data-start>开始标注</button></div>' +
      '<div class="pa-list" data-list></div>' +
      '<div class="pa-ft"><button class="pa-exp" data-export>' + svg('down') + ' 复制反馈</button></div>';

    var hint = el('div', 'pa-hint', '标注中：点页面元素写意见，Alt 临时穿透，Esc 结束');

    document.body.append(panel, hint, fab);

    var ctx = {
      panel: panel, fab: fab,
      toggle: function () { ctx.setOpen(!panel.classList.contains('on')); },
      setOpen: function (open) {
        panel.classList.toggle('on', open);
        fab.classList.toggle('hide', open);
        if (open) { ctx.list(); ctx.syncBtn(); }
      },
      syncBtn: function () {
        var b = panel.querySelector('[data-start]');
        b.classList.toggle('on', on);
        b.textContent = on ? '结束标注（Esc）' : '开始标注';
        panel.querySelector('[data-n]').textContent = pins.length;
      },
      /** 汇总所有 frame 的桶，按页面分组渲染。每项知道自己属于哪个桶，
          所以 textarea 输入直接写回对应的 key，不需要「当前页」的概念。 */
      list: function () {
        return allPins().then(function (all) {
          var box = panel.querySelector('[data-list]');
          var total = 0;
          Object.keys(all).forEach(function (k) { total += all[k].length; });
          panel.querySelector('[data-n]').textContent = total;
          box.textContent = '';
          if (!total) {
            box.appendChild(el('div', 'pa-empty', '还没有标注<br>点「开始标注」，再点页面上的元素'));
            return;
          }
          Object.keys(all).sort().forEach(function (k) {
            if (!all[k].length) return;
            // iframe 内的 frame 面板不显示（只有顶层有面板），但当前页排在最前
            box.appendChild(el('div', 'pa-grp', k + '（' + all[k].length + '）'));
            all[k].forEach(function (p, i) { box.appendChild(row(k, p, i)); });
          });
        });
      }
    };

    function row(bucket, p, idx) {
      var item = el('div', 'pa-item');
      item.innerHTML =
        '<div class="pa-meta"><span class="pa-tag">' + (idx + 1) + '</span>' +
        '<span class="pa-path" title="' + esc(p.textSnippet || p.target) + '">' + esc(p.cssPath) + '</span>' +
        '<button class="pa-del" title="删除">×</button></div>' +
        '<textarea placeholder="要改什么？"></textarea>';
      var ta = item.querySelector('textarea');
      ta.value = p.comment || '';
      ta.addEventListener('input', function () { setComment(bucket, p.id, ta.value); });
      // 光标停在哪个标注上，页面上对应钉子描个边
      ta.addEventListener('focus', function () {
        var n = pinNodes[p.id];
        if (n) { n.style.boxShadow = '0 0 0 3px #fff,0 0 0 5px #f59e0b'; }
      }, true);
      ta.addEventListener('blur', function () {
        var n = pinNodes[p.id];
        if (n) n.style.boxShadow = '';
      }, true);
      item.querySelector('.pa-del').addEventListener('click', function () {
        removePin(bucket, p.id);
      });
      return item;
    }

    panel.querySelector('[data-close]').addEventListener('click', function () { ctx.setOpen(false); });
    panel.querySelector('[data-start]').addEventListener('click', function () { setMode(!on); });
    panel.querySelector('[data-export]').addEventListener('click', exportMd);
    panel.querySelector('[data-clear]').addEventListener('click', function () {
      if (!confirm('清空「' + PAGE_KEY + '」的全部标注？')) return;
      pins = [];
      writePins();
      paint();
      ctx.list();
    });

    return ctx;
  }

  /* ---------------- 导出 ---------------- */
  function toMd(list, label) {
    if (!list.length) return '';
    var body = list.map(function (p, i) {
      return [
        (i + 1) + '. **' + (p.textSnippet || p.target) + '**',
        '   - 位置：`' + p.cssPath + '`',
        '   - 元素：`' + p.target + '`',
        '   - 意见：' + ((p.comment || '').trim() || '（未填写）')
      ].join('\n');
    }).join('\n');
    return '## ' + label + '（' + list.length + ' 条）\n\n' + body;
  }

  function exportMd() {
    allPins().then(function (all) {
      var keys = Object.keys(all).filter(function (k) { return all[k].length; }).sort();
      if (!keys.length) { say('还没有标注'); return; }
      var md = ['# 页面标注反馈', ''];
      keys.forEach(function (k) { md.push(toMd(all[k], k), ''); });
      copy(md.join('\n'));
      say('已复制 ' + keys.length + ' 个页面的标注');
    });
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(
      function () { say('反馈已复制到剪贴板'); },
      function () { say('复制失败，请手动选中面板内容'); }
    );
  }

  var sayTimer = null;
  function say(msg) {
    injectStyle();
    var t = document.getElementById('pa-toast');
    if (!t) {
      t = el('div');
      t.id = 'pa-toast';
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:18px;z-index:2147483647;' +
        'background:rgba(15,23,42,.92);color:#fff;padding:8px 16px;border-radius:8px;font:13px/1.5 ' +
        '-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(sayTimer);
    sayTimer = setTimeout(function () { t.style.display = 'none'; }, 2400);
  }

  /* ---------------- 跨 frame 同步 ----------------
     storage 变更通知是扩展原生机制，不需要自己定协议、不需要 postMessage。
     两类变更：
       pa:mode     —— 别的 frame 开关了标注模式，我跟着开或关
       pa:pins:*   —— 别的 frame（通常是 iframe）新增/删除了标注，面板刷新 */
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    // 只有顶层会写 MODE_KEY（iframe 只跟读）。自己写完 on 已经是目标值，
    // 所以这里的相等判断天然跳过自己那次通知，不会回环。
    if (changes[MODE_KEY]) {
      var want = !!changes[MODE_KEY].newValue;
      if (want !== on) setMode(want, false);
    }

    var touched = Object.keys(changes).filter(function (k) { return k.indexOf(PIN_PREFIX) === 0; });
    if (!touched.length) return;

    /* 打字时不要重建列表，否则 textarea 失焦。
       自己刚写过的那个桶要跳过——注意桶不一定是本 frame 的：
       面板里可能正在编辑 iframe 的标注，所以按完整存储 key 精确比对，
       而不是只看 PAGE_KEY。 */
    var allSelf = true;
    touched.forEach(function (k) {
      if (selfWrites[k] !== JSON.stringify(changes[k].newValue || [])) allSelf = false;
    });
    selfWrites = {};
    if (allSelf && touched.length === 1) return;   // 全是自己写的，不动 UI

    getPins(PAGE_KEY).then(function (list) {
      pins = list;
      paintPins();
      if (ui) ui.syncBtn();
    });
    if (ui) ui.list();
  });

  /* 点扩展图标：让当前页显示/隐藏面板。只有顶层有面板，iframe 里收到就转交上去。 */
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'PA_TOGGLE') return;
    if (ui) ui.toggle();
  });

  /* ---------------- 启动 ---------------- */
  function boot() {
    injectStyle();

    getPins(PAGE_KEY).then(function (list) {
      pins = list;
      paintPins();
    });

    // 顶层重置模式标志：否则上次忘了关，下次打开页面点击就被标注吃掉
    if (IS_TOP) store.set({ [MODE_KEY]: false });
    else store.get(MODE_KEY).then(function (r) { if (r[MODE_KEY]) setMode(true, false); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && on) setMode(false);
    }, true);

    if (IS_TOP) {
      ui = buildPanel();
      ui.list();
    } else {
      ensureLayer();   // iframe 也要能画钉子，只是没有面板
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
