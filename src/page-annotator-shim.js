/* ==========================================================================
   page-annotator-shim.js —— page-annotator 内嵌适配层（必须先于 page-annotator.js 加载）

   上游是 Chrome MV3 扩展（ssh://git@git.wbsyb.cloud:8282/sobey/page-annotator.git），
   存取走 chrome.storage.local。内嵌到本工作台页面时没有扩展环境，
   这里用 localStorage 模拟同签名的 Promise 接口；跨 frame 的 onChanged /
   runtime.onMessage 在单页场景用不到，注册为空操作。

   注意：page-annotator.js 保持与上游逐字节一致，方便以后 diff 同步；
   一切适配只在本文件做。

   ==========================================================================
   一、视图感知（2026-10-09：切走页面后标记还浮在最上层）

   工作台是单页应用，切「创作/素材/人设/任务/下载」都不改 location，
   而插件的 PAGE_KEY = location.pathname + location.search（page-annotator.js:40）
   恒为 "/"。于是五个页面的钉子全部落进同一个桶 pa:pins:/。

   修法：不改 vendor，只在存储层把「页面桶」细化成「视图桶」——
       pa:pins:/  →  pa:pins:/|v=create      （视图取 body[data-view]）
   视图一变就补发一次 pa:pins:* 变更通知，插件重新读桶 + 重画钉子。

   ==========================================================================
   二、面板与导出聚合所有视图（2026-10-10：切到别的板块后标注不见了）

   钉子仍只画在自己所属的视图上（坐标是文档坐标，跨视图显示必错位），
   但 store.get(null) 把**所有视图**的桶都交出去：当前视图用裸键「/」
   （插件据此同步本页钉子，因为 vendor 内部按 bucket === PAGE_KEY 判断），
   其他视图用**中文视图名**做键。展示键 → 存储键的映射放在 DISPLAY_KEYS
   里，编辑/删除时经 toStorageKey 路由回正确的桶。

   ==========================================================================
   三、标完自动暂停（2026-10-10：标完一个元素后点别的板块点不动）

   病因：插件的标注模式是 document 捕获阶段的 click 拦截
   （page-annotator.js:308-311 /328-334），命中就 preventDefault + stopPropagation。
   捕获阶段在 document 上拦下，事件根本到不了目标元素——
   标注开着的时候，顶部导航、输入框、所有按钮一律点不动。

   修法：
   1) store.set 补上 onChanged 通知（原先只写不报，与真实 chrome.storage 不符，
      导致外部无法反向通知插件）。插件内部用 selfWrites 去重，不会成环。
   2) 检测「桶变长」=新增了一条标注 → 把 pa:mode 写 false 并补发通知，
      插件走 setMode(false,false)，当场摘掉拦截器。
      默认关闭（连续标注是核心诉求）；面板里有「标完一条自动暂停」可开。
   3) .pa-hint / #pa-toast 加 pointer-events:none——这两个浮层显示期间是实心 div，
      会在底部中央 / 顶部中央各挡一块点击区。

   ==========================================================================
   四、清空按钮拦截（2026-10-10：清空按钮没生效）

   面板聚合后显示的是所有视图的标注，但 vendor 的 [data-clear]
   只写当前视图的空桶（page-annotator.js:422-428），其他视图的标注留在面板上，
   用户看到的就是「没生效」。修法同五：捕获阶段拦下，由本 shim 清全部视图桶。

   ==========================================================================
   五、视觉重做（2026-10-11：太丑，配色和文字重新设计，说明收进右上角 ?）

   vendor 默认那套蓝（#2563eb）+ 大段 tip 文字，跟任何工作台都不搭。
   改为纯白净版：白底 + 中性灰阶 + 单一强调色，说明文字全部收进面板头部
   的「?」弹层，设置区只留一个开关。详见下面的 THEME_CSS。

   ==========================================================================
   六、功能补齐（2026-10-11：作为独立项目维护，功能先完善）

   1) 导出接管：vendor 的 exportMd 直接拿桶键当标题，输出里会漏出
      「/|v=create」这类内部键。改为捕获阶段接管 [data-export]，
      自己按视图顺序聚合、生成干净的 Markdown（含页面地址、时间、统计），
      剪贴板失败时降级为下载文件。
   2) 新增「下载 .md」按钮，与「复制反馈」并排。
   3) 新增筛选框：按文字/路径/意见过滤标注项；面板每次重绘后自动重挂过滤。
   4) 面板分组头不再显示内部键：裸键「/」在 DOM 上改写成当前视图中文名。

   ==========================================================================
   七、宿主解耦（2026-10-11：抽成可复用独立项目）

   原先视图名（创作/素材/人设…）是写死的 bobo 工作台专有值。本文件抽成独立
   组件后，这些全部改为从 `window.PageAnnotator.config` 读取，宿主项目只需：

     <script>window.PageAnnotator = { config: {
       viewNames: { home: '首页', detail: '详情' },   // 视图 id → 展示名
       viewOrder: ['home', 'detail'],                 // 面板分组/导出章节顺序
       viewAttr: 'data-view'                          // 单页应用切视图时改哪个属性
     } };
     </script>
     <script src="page-annotator-shim.js" defer></script>
     <script src="page-annotator.js" defer></script>

   不传 config 也能跑：自动退化为「单视图」模式，所有标注归到一个分组，
   展示名为「本页」。多页应用（每次导航真的换 location）则天然无需视图分桶。
   ========================================================================== */
(function () {
  'use strict';

  var PIN_PREFIX = 'pa:pins:';
  var MODE_KEY = 'pa:mode';

  /* ---------------- 宿主配置 ---------------- */
  var CFG = (function () {
    var user = (window.PageAnnotator && window.PageAnnotator.config) || {};
    var names = user.viewNames || {};
    return {
      viewNames: names,
      viewOrder: user.viewOrder || [],
      viewAttr: user.viewAttr || 'data-view',
      /* 视图分桶只在宿主显式配了 viewNames 时启用（单页应用才会需要）。
         未配置时 SINGLE_VIEW=true，下面的 VIEW_SEP 退化成空串，
         所有视图键拼接自动变成恒等变换 —— 桶键等于 vendor 的原始 PAGE_KEY，
         既不会把同一页的标注裂成两个桶，也不用维护任何 bobo 专有的视图 id。 */
      singleView: !Object.keys(names).length
    };
  })();

  /* 视图分隔符。单视图模式下是空串，分桶机制整体失效。 */
  var VIEW_SEP = CFG.singleView ? '' : '|v=';

  /* vendor 的「本页桶」后缀。必须和 page-annotator.js:40 的算法逐字一致，
     否则两套算法算出的 PAGE_KEY 不同 → 同一页的标注被写进两个桶。
     原先这里硬编码 '/'，那只是 bobo 工作台恰好部署在站点根目录的巧合，
     换到 /foo/bar.html 的项目就会裂桶。 */
  var PAGE_KEY = (location.pathname + location.search || '/').replace(/\/index\.html?$/, '/');

  var VIEW_NAMES = CFG.viewNames;
  var VIEW_ORDER = CFG.viewOrder;

  /* 展示键 → 存储键。每次 get(null) 重建，面板编辑/删除靠它路由。
     展示键是**页面键**（vendor 眼里 PAGE_KEY = "/" 的那一层），不含 pa:pins: 前缀。 */
  var DISPLAY_KEYS = {};

  /* ---------------- 视图键 ---------------- */
  function currentView() {
    /* 单视图模式：不分桶。返回空串配合空 VIEW_SEP，所有键拼接都是恒等变换。 */
    if (CFG.singleView) return '';
    var v = '';
    try {
      v = (document.body && document.body.getAttribute(CFG.viewAttr)) || '';
    } catch (e) { /* body 还没出来 */ }
    return v || '__default__';
  }
  function currentViewName() {
    if (CFG.singleView) return '本页';
    return VIEW_NAMES[currentView()] || '本页';
  }
  /* 在键里找视图后缀的起点。单视图模式没有后缀概念，一律返回 -1。
     绝不能直接用 k.indexOf('') —— 空串会让 indexOf 恒返回 0，
     导致 toStorageKey 把 pa:pins:/ 当成「带后缀的键」再拼一遍前缀。 */
  function viewSepIndex(k) {
    if (CFG.singleView) return -1;
    return k.indexOf(VIEW_SEP);
  }
  /** 插件给的键 → 实际存储键（只翻译钉子桶，pa:mode 等原样放行）。 */
  function toStorageKey(k) {
    if (typeof k !== 'string' || k.indexOf(PIN_PREFIX) !== 0) return k;
    var disp = k.slice(PIN_PREFIX.length);                 // 剥掉前缀，得到展示键
    if (DISPLAY_KEYS[disp]) return DISPLAY_KEYS[disp];      // 面板展示键（当前页展示键 / 中文视图名）
    if (CFG.singleView) return k;                          // 单视图：原键原样放行
    var i = viewSepIndex(k);
    /* 已带视图后缀 → 把页面部分统一换成 vendor 眼里的 PAGE_KEY（视图部分保留）。
       不能写死 '/'：那只是 bobo 恰好在根目录的巧合。 */
    if (i >= 0) return PIN_PREFIX + PAGE_KEY + VIEW_SEP + k.slice(i + VIEW_SEP.length);
    return k + VIEW_SEP + currentView();
  }
  /** 实际存储键 → 展示键（去掉 pa:pins: 前缀与视图后缀） */
  function toBareKey(k) {
    var s = k.indexOf(PIN_PREFIX) === 0 ? k.slice(PIN_PREFIX.length) : k;
    var i = viewSepIndex(s);
    return i >= 0 ? s.slice(0, i) : s;
  }
  function viewOf(k) {
    var i = viewSepIndex(k);
    return i >= 0 ? k.slice(i + VIEW_SEP.length) : '';
  }

  /* 遗留桶迁移：只服务于「从多视图配置切成单视图」的场景 ——
     之前按 |v=xxx 分的桶，在单视图模式下不再被识别，需要并回裸键。
     单视图模式（从未配过 viewNames）下整段跳过：此时 VIEW_SEP 是空串，
     `k.indexOf('') >= 0` 恒为真，不跳过会把用户已有的标注桶全部删光。 */
  (function migrateLegacy() {
    if (CFG.singleView) return;
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(PIN_PREFIX) !== 0 || k.indexOf(VIEW_SEP) >= 0) continue;
      var list = null;
      try { list = JSON.parse(localStorage.getItem(k)); } catch (e) { list = null; }
      if (list && list.length) {
        var target = k + VIEW_SEP + currentView();
        if (localStorage.getItem(target) === null) localStorage.setItem(target, JSON.stringify(list));
      }
      localStorage.removeItem(k);
    }
  })();

  /* ---------------- onChanged：真正可触发的监听表 ----------------
     插件在 page-annotator.js:488 注册监听；视图切换 / 自动暂停由本文件补发通知。 */
  var changeListeners = [];
  function emitChanges(changes) {
    if (!changeListeners.length) return;
    changeListeners.slice().forEach(function (fn) {
      try { fn(changes, 'local'); } catch (e) { /* 单个监听抛错不影响页面 */ }
    });
  }
  function emitPinChange() {
    /* 用 vendor 同款 PAGE_KEY 拼本页桶。多视图时再由 toStorageKey 追加 |v=xxx。 */
    var bucketKey = PIN_PREFIX + PAGE_KEY;
    var next = null;
    try { next = JSON.parse(localStorage.getItem(toStorageKey(bucketKey)) || 'null'); } catch (e) { next = null; }
    var changes = {};
    changes[bucketKey] = { oldValue: undefined, newValue: next || [] };
    emitChanges(changes);
  }

  /* ---------------- chrome.storage.local 模拟 ---------------- */
  var store = {
    /* get(key)：key 为字符串读单键；key 为 null 读全部 pa: 桶（上游 allPins 的用法） */
    get: function (key) {
      return new Promise(function (resolve) {
        var out = {};
        try {
          if (key === null) {
            var cur = currentView();
            DISPLAY_KEYS = {};
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              if (!k || k.indexOf('pa:') !== 0) continue;
              if (k.indexOf(PIN_PREFIX) === 0) {
                var vv = viewOf(k);
                var disp;
                if (vv && vv !== cur) {
                  // 其他视图：用中文视图名做展示键，面板分组/导出标题才不是内部键。
                  // __default__ 是「页面存在但没设 data-view」的兜底 id，
                  // 不配 viewNames 时不能把它漏到面板里，统一显示「本页」。
                  disp = VIEW_NAMES[vv] || (vv === '__default__' ? '本页' : vv);
                } else {
                  // 当前视图：必须用裸键 "/"（去掉 |v= 后缀），插件按 bucket === PAGE_KEY 判断
                  disp = toBareKey(k);
                }
                DISPLAY_KEYS[disp] = k;
                out[PIN_PREFIX + disp] = JSON.parse(localStorage.getItem(k));
              } else {
                out[k] = JSON.parse(localStorage.getItem(k));
              }
            }
          } else {
            var v = localStorage.getItem(toStorageKey(key));
            if (v !== null) out[key] = JSON.parse(v);
          }
        } catch (e) { /* 坏数据当空处理 */ }
        resolve(out);
      });
    },
    set: function (obj) {
      return new Promise(function (resolve) {
        var changes = {};
        try {
          Object.keys(obj).forEach(function (k) {
            var sk = toStorageKey(k);
            var raw = localStorage.getItem(sk);
            var oldValue;
            try { oldValue = raw === null ? undefined : JSON.parse(raw); } catch (e) { oldValue = undefined; }
            localStorage.setItem(sk, JSON.stringify(obj[k]));
            changes[k] = { oldValue: oldValue, newValue: obj[k] };
          });
        } catch (e) { /* localStorage 满/被禁用时静默失败，不打断页面 */ }
        resolve();
        afterWrite(changes);
      });
    }
  };

  /* ---------------- 就地登记弹层（对标 Codex：点元素 → 就地写需求） ----------------
     vendor 的做法是「点一下落个钉子，意见去右侧面板写」——两步、且面板在屏幕另一侧，
     连续标多个元素时视线要来回跳。Codex 的交互是点中元素后原地弹一个小输入框，
     写完提交就回到待命，业务页面立刻能用。

     这里新增弹层，把 vendor 落的钉子接过来就地编辑：
       新增 → 弹层自动聚焦，用户敲需求
       Enter / 提交 → 写回该钉子的 comment，立刻结束标注模式（回到待命）
       Esc / 点外面 → 放弃这条钉子（从桶里删掉），同样结束标注模式
     位置贴着被点的元素算，越界时自动翻边，滚动时跟随。 */
  var POP_ID = 'pa-entry-pop';
  var popPin = null;
  var popUserMoved = false;   // 本次打开后用户是否手动拖过弹窗
  var POP_CSS_READY = false;
  var toastTimer = null;   // 在 openEntry 用到，须早于它声明（var 提升但赋值不会）

  function popEl() {
    var el = document.getElementById(POP_ID);
    if (!el) {
      /* 样式可能还没注入（面板未打开时用户就可能点元素），这里兜底补一次 */
      if (!POP_CSS_READY) {
        POP_CSS_READY = true;
        if (!document.getElementById('pa-entry-style')) {
          var st = document.createElement('style');
          st.id = 'pa-entry-style';
          st.textContent = THEME_CSS;
          (document.head || document.documentElement).appendChild(st);
        }
      }
      el = document.createElement('div');
      el.id = POP_ID;
      el.className = 'pa-entry';
      el.setAttribute('data-pa', '');        // 排除"标注到自己"，否则弹层里的点击会被吃掉
      el.innerHTML =
        '<div class="pa-entry-hd"><span class="pa-entry-t"></span>' +
        '<button type="button" class="pa-entry-x" title="放弃这条（Esc）">×</button></div>' +
        '<textarea placeholder="要改什么？Enter 提交，Esc 放弃"></textarea>' +
        '<div class="pa-entry-ft"><span class="pa-entry-tip">Enter 提交 · Esc 放弃</span>' +
        '<button type="button" class="pa-entry-ok">登记</button></div>';
      (document.body || document.documentElement).appendChild(el);
      var ta = el.querySelector('textarea');
      ta.addEventListener('keydown', function (e) {
        e.stopPropagation();                // 别让 Shift+A / Esc 的全局监听抢走按键
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEntry(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEntry(); }
      });
      el.querySelector('.pa-entry-ok').addEventListener('click', commitEntry);
      el.querySelector('.pa-entry-x').addEventListener('click', cancelEntry);
      el.addEventListener('mousedown', function (e) { e.stopPropagation(); });

      /* 头部当把手。被拖动后 popUserMoved=true，后续 placePop 不再把弹窗
         拉回元素锚点 —— 用户明确摆了位置就别跟元素抢。 */
      makeDraggable(el, el.querySelector('.pa-entry-hd'), {
        onMove: function () { popUserMoved = true; }
      });
    }
    return el;
  }

  /** 贴着 (vx, vy) 摆弹层，越界翻边。pin.x/y 是文档坐标，要减滚动量。
      用户手动拖过就不再跟随元素，否则 scroll 跟随会把拖好的位置拽回去。 */
  function placePop(vx, vy) {
    var el = popEl();
    if (popUserMoved) return;
    var w = el.offsetWidth || 288, h = el.offsetHeight || 150;
    var left = vx + 14, top = vy + 14;
    if (left + w > window.innerWidth - 12) left = vx - w - 14;
    if (left < 12) left = 12;
    if (top + h > window.innerHeight - 12) top = vy - h - 14;
    if (top < 12) top = 12;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    /* 每次按锚点摆都要清掉拖拽可能设的 right/bottom，否则会被反向拉伸 */
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function movePop() {
    if (!popPin) return;
    placePop(popPin.x - window.scrollX, popPin.y - window.scrollY);
  }

  function openEntry(pin) {
    if (!pin) return;
    popPin = pin;
    popUserMoved = false;      // 每次新开一条都重新贴着元素，用户一拖就不再跟随
    var el = popEl();
    el.querySelector('.pa-entry-t').textContent = pin.target || '元素';
    var ta = el.querySelector('textarea');
    ta.value = pin.comment || '';
    el.style.display = 'block';
    placePop(pin.x - window.scrollX, pin.y - window.scrollY);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function closePop() {
    popPin = null;
    var el = document.getElementById(POP_ID);
    if (el) el.style.display = 'none';
  }

  /** 提交这条意见。连续标注开着就继续标，否则回待命。 */
  function commitEntry() {
    var pin = popPin;
    if (!pin) return;
    var text = (popEl().querySelector('textarea').value || '').trim();
    closePop();
    writeComment(pin, text);
    if (continuous) { toast('已登记，继续标下一个'); return; }
    pauseAfterPin();                 // 回到待命，业务页面立刻可用
    toast(text ? '已登记，页面恢复可点' : '已登记（未填意见）');
  }

  /** 放弃这条：把刚落的钉子删掉。 */
  function cancelEntry() {
    var pin = popPin;
    closePop();
    if (pin) removePinById(pin.id);
    if (!continuous) pauseAfterPin();
    toast('已放弃这条标注');
  }

  /* vendor 眼里的"本页桶"（未加视图后缀）；多视图时由 toStorageKey 追加 |v=xxx */
  function currentBucket() { return toStorageKey(PIN_PREFIX + PAGE_KEY); }

  /** 直接改当前视图的钉子桶。内部写回，置 internalWrite 防误判成"用户新增"。 */
  function mutateBucket(fn) {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(currentBucket()) || '[]'); } catch (e) { raw = []; }
    var next = fn(raw) || raw;
    var changes = {};
    changes[PIN_PREFIX + PAGE_KEY] = { oldValue: raw, newValue: next };
    try { localStorage.setItem(currentBucket(), JSON.stringify(next)); } catch (e) { return; }
    internalWrite = true;
    emitChanges(changes);
    setTimeout(function () { internalWrite = false; }, 0);
  }

  function writeComment(pin, text) {
    mutateBucket(function (raw) {
      return raw.map(function (p) { if (p.id === pin.id) p.comment = text; return p; });
    });
  }

  function removePinById(id) {
    mutateBucket(function (raw) {
      return raw.filter(function (p) { return p.id !== id; });
    });
  }

  /* 点弹层外面 = 放弃（等价 Esc）。捕获阶段拦，避免被页面自己的点击逻辑影响。 */
  document.addEventListener('mousedown', function (e) {
    if (!popPin) return;
    var el = document.getElementById(POP_ID);
    if (el && el.contains(e.target)) return;
    cancelEntry();
  }, true);

  window.addEventListener('resize', movePop);
  window.addEventListener('scroll', movePop, true);

  /* ---------------- 标注模式收尾策略 ---------------- */
  var continuous = false;   // 连续标注：提交后不退出，可以接着点下一个元素
  var internalWrite = false;  // 内部写回（改意见/删钉子）期间置位，避免被当成"用户新增"
  var HINT_ON = '标注中 · 点元素就地问需求 · Enter 提交 · Esc 放弃';

  function afterWrite(changes) {
    // 桶变长 = 新增了一条标注（改意见长度不变、删除会变短，都不算）
    var newPin = null;
    Object.keys(changes).forEach(function (k) {
      if (k.indexOf(PIN_PREFIX) !== 0) return;
      var nv = changes[k].newValue;
      if (!Array.isArray(nv)) return;
      // oldValue 在桶还不存在时是 undefined，要当空数组算——否则**第一次**点元素不弹框
      var ov = Array.isArray(changes[k].oldValue) ? changes[k].oldValue : [];
      if (nv.length <= ov.length) return;
      newPin = nv[nv.length - 1] || null;    // vendor 只 push，新增的必是末尾那条
    });

    emitChanges(changes);

    if (!newPin || internalWrite) return;
    openEntry(newPin);                        // Codex 式：点中就地弹层写需求
  }

  /** 直接改标志 + 补发通知，不走 store.set，避免递归。 */
  function pauseAfterPin() {
    var wasOn = false;
    try { wasOn = localStorage.getItem(MODE_KEY) === 'true'; } catch (e) { wasOn = false; }
    if (!wasOn) return;
    try { localStorage.setItem(MODE_KEY, 'false'); } catch (e) { return; }
    var changes = {};
    changes[MODE_KEY] = { oldValue: true, newValue: false };
    emitChanges(changes);            // 插件收到后走 setMode(false,false)，摘掉 click/mousemove 拦截
  }

  /** 清空所有视图的标注桶，并通知插件重读重画。 */
  function clearAllViews(btn) {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && k.indexOf(PIN_PREFIX) === 0) localStorage.removeItem(k);
    }
    var changes = {};
    changes[PIN_PREFIX + PAGE_KEY] = { oldValue: undefined, newValue: [] };
    emitChanges(changes);            // 插件收到后重读本页桶（空）→ paintPins 清钉子、list 刷面板
    toast('已清空全部标注');
    resetClearArm(btn);
  }

  /* 二次确认：不用浏览器原生 confirm（弹窗会打断标注节奏，也和整套纯白 UI 不搭）。
     第一次点「清空」→ 按钮转警示红并浮出「再点一次确认」；5 秒内不再点、超时或
     点到别处就自动还原。清空按钮是图标按钮（内含 SVG），所以不改 textContent，
     只切data 属性 + CSS 伪元素，否则图标会被文字顶掉。 */
  var CLEAR_ARM_MS = 5000;
  var clearTimer = null;

  function resetClearArm(btn) {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    if (!btn) return;
    btn.removeAttribute('data-clear-armed');
    btn.setAttribute('title', '清空全部标注（各板块一起删除，需点两次）');
  }

  function armClear(btn) {
    btn.setAttribute('data-clear-armed', '1');
    btn.setAttribute('title', '再点一次确认清空（5 秒内有效）');
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(function () { resetClearArm(btn); }, CLEAR_ARM_MS);
  }

  function onClearClick(btn) {
    if (btn.getAttribute('data-clear-armed') === '1') clearAllViews(btn);
    else armClear(btn);
  }

  /* ---------------- 导出（接管 vendor 的 exportMd） ----------------
     vendor 直接拿桶键当章节标题，输出里会漏出「/|v=create」这类内部键。
     这里自己聚合：当前视图排最前，其余按 VIEW_ORDER，标题用中文视图名。 */
  function collectGroups() {
    var cur = currentView();
    var buckets = {};        // viewId -> {name, list}
    var order = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(PIN_PREFIX) !== 0) continue;
      var vid = viewOf(k) || cur;
      var list = null;
      try { list = JSON.parse(localStorage.getItem(k)) || []; } catch (e) { list = []; }
      if (!list.length) continue;
      /* 分组名：宿主配了中文名就用中文名；否则用「本页」，
         不能把 __default__ 这类内部 id 漏到面板和导出里。 */
      if (!buckets[vid]) {
        buckets[vid] = { name: (CFG.singleView || vid === cur) ? currentViewName() : (VIEW_NAMES[vid] || vid), list: [] };
        order.push(vid);
      }
      buckets[vid].list = buckets[vid].list.concat(list);
    }
    order.sort(function (a, b) {
      if (a === cur) return -1;
      if (b === cur) return 1;
      var ia = VIEW_ORDER.indexOf(a), ib = VIEW_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return order.map(function (vid) { return buckets[vid]; });
  }

  function stamp() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function buildMarkdown() {
    var groups = collectGroups();
    if (!groups.length) return '';
    var total = 0;
    groups.forEach(function (g) { total += g.list.length; });

    var head = ['# 页面标注反馈', ''];
    head.push('- 页面：' + (location.origin + location.pathname));
    head.push('- 时间：' + stamp());
    head.push('- 标注：' + total + ' 条（' +
      groups.map(function (g) { return g.name + ' ' + g.list.length; }).join(' / ') + '）');
    head.push('');

    var body = [];
    groups.forEach(function (g) {
      body.push('## ' + g.name + '（' + g.list.length + ' 条）', '');
      g.list.forEach(function (p, i) {
        body.push((i + 1) + '. **' + ((p.textSnippet || p.target || '').trim() || '（无文字）') + '**');
        body.push('   - 元素：`' + (p.target || '') + '`');
        if (p.cssPath) body.push('   - 位置：`' + p.cssPath + '`');
        body.push('   - 意见：' + (((p.comment || '').trim()) || '（未填写）'));
      });
      body.push('');
    });
    return head.concat(body).join('\n');
  }

  /** 把 Markdown 放进剪贴板；剪贴板不可用时退回下载文件。 */
  function copyOrDownload(text, done) {
    function download() {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '页面标注反馈-' + stamp().replace(/[-: ]/g, '') + '.md';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      if (done) done(false, '剪贴板不可用，已改为下载 Markdown 文件');
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      if (legacyCopy(text)) { if (done) done(true, '反馈已复制到剪贴板'); return; }
      download();
      return;
    }
    navigator.clipboard.writeText(text).then(
      function () { if (done) done(true, '反馈已复制到剪贴板'); },
      function () {                       // 权限被拒 → 换老路，再不行才下载
        if (legacyCopy(text)) { if (done) done(true, '反馈已复制到剪贴板'); return; }
        download();
      }
    );
  }

  /** 老办法复制：HTTP 环境（非安全上下文）下 navigator.clipboard 不存在，只能走这个。 */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function exportMd() {
    var md = buildMarkdown();
    if (!md) { toast('还没有标注'); return; }
    // 复制成功就只复制，别顺手再下载一个文件
    copyOrDownload(md, function (ok, msg) { toast(msg); });
  }

  /* ---------------- 通用拖拽（面板 + 就地弹窗）----------------
     两个浮层都做成「可拖到任意位置、位置记住」：
       - 用 pointer 事件统一处理鼠标/触控/笔，setPointerCapture 防止
         指针移出元素后丢失 move 事件。
       - 位置存 sessionStorage（面板是常驻控件，跨页面刷新不该丢；
         弹层每次打开都重新贴着元素，直接复用上次位置反而不自然，
         所以弹层不持久化，只在本次打开期间可拖）。
       - 拖拽时给 body 加 pa-dragging 抑制文本选中，
         并在松手时 clamp 回视口，避免拖到屏幕外找不回来。
       - 位置按「视口坐标」存：面板是 position:fixed，用视口坐标最直接；
         弹窗同样 fixed，滚动页面时不会漂。 */
  var DRAG_KEY = 'pa:panelpos';
  var dragState = null;

  function clampToViewport(x, y, w, h) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var M = 8;   // 留一点边距，别让把手整个贴到屏幕外抓不住
    return {
      x: Math.min(Math.max(x, M), Math.max(M, vw - w - M)),
      y: Math.min(Math.max(y, M), Math.max(M, vh - h - M))
    };
  }

  /**
   * 给 el 装上拖拽能力。handle 是拖拽把手；el 自身用 position:fixed 定位。
   * opts.persist 存不存位置；opts.onMove 拖动时的额外回调（弹窗要脱离元素锚点）。
   */
  function makeDraggable(el, handle, opts) {
    opts = opts || {};
    if (!el || !handle || el.__paDraggable) return;
    el.__paDraggable = true;

    handle.addEventListener('pointerdown', function (e) {
      // 只认左键；别抢按钮/输入框的点击
      if (e.button !== 0) return;
      var t = e.target;
      if (t && (t.closest('button,input,select,textarea,a,[contenteditable]'))) return;

      var r = el.getBoundingClientRect();
      dragState = {
        el: el,
        dx: e.clientX - r.left,      // 按住点在元素内的相对位置
        dy: e.clientY - r.top,
        w: r.width, h: r.height,
        moved: false
      };
      /* vendor 用 right/top 锚定面板。切到 left/top 锚定时必须先把当前视觉位置
         写回 left/top 再清 right —— 直接清会让元素瞬间跳回左上角，
         而拖拽起点记的是切换前的位置，手感就错位了。 */
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 旧浏览器降级 */ }
      document.body.classList.add('pa-dragging');
      el.classList.add('pa-dragging');
      e.preventDefault();
      if (opts.onStart) opts.onStart();
    });

    handle.addEventListener('pointermove', function (e) {
      if (!dragState || dragState.el !== el) return;
      var p = clampToViewport(
        e.clientX - dragState.dx,
        e.clientY - dragState.dy,
        dragState.w, dragState.h
      );
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      dragState.moved = true;
      if (opts.onMove) opts.onMove(p);
    });

    function endDrag(e) {
      if (!dragState || dragState.el !== el) return;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      document.body.classList.remove('pa-dragging');
      el.classList.remove('pa-dragging');
      dragState = null;
      if (opts.persist) savePos(el);
      if (opts.onEnd) opts.onEnd();
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  function savePos(el) {
    try {
      var r = el.getBoundingClientRect();
      sessionStorage.setItem(DRAG_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch (e) { /* 隐私模式下 sessionStorage 可能不可写 */ }
  }
  function restorePos(el) {
    var raw = null;
    try { raw = sessionStorage.getItem(DRAG_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var d = null;
    try { d = JSON.parse(raw); } catch (e) { return false; }
    if (!d || typeof d.x !== 'number' || typeof d.y !== 'number') return false;
    var r = el.getBoundingClientRect();
    var p = clampToViewport(d.x, d.y, r.width, r.height);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.right = 'auto';    // 覆盖 vendor 的 right 锚定
    el.style.bottom = 'auto';
    return true;
  }

  /* ---------------- 视觉重做：纯白净版 ----------------
     策略：白底 + 中性灰阶承担层级，强调色只留一个靛蓝（#4f46e5），
     危险态用红。覆盖写在 vendor 的 #pa-style 之后，同优先级后定义者胜，
     关键项再补 !important 兜底（vendor 部分样式是 JS 内联写的）。 */
  var THEME_CSS = [
    /* 浮层点击穿透：这两个是实心 div，显示期间各挡一块点击区 */
    '#pa-toast,.pa-hint{pointer-events:none!important}',

    /* ---------------- 拖拽 ---------------- */
    /* 拖拽中：全局禁止文本选中，否则按住拖会一路刷蓝 */
    'body.pa-dragging,body.pa-dragging *{user-select:none!important;-webkit-user-select:none!important;' +
      'cursor:grabbing!important}',
    /* 把手区域：整条头部都能拖，不要求精确点中某个小图标 */
    '.pa-hd,.pa-entry-hd{cursor:grab}',
    '.pa-hd .pa-b,.pa-hd b,.pa-entry-hd .pa-entry-t{cursor:grab}',
    /* 把手上盖一层不可见的加高命中区，窄头部也容易按住 */
    '.pa-hd::before,.pa-entry-hd::before{content:"";position:absolute;inset:0;cursor:grab}',
    '.pa-hd{position:relative}',
    '.pa-entry-hd{position:relative}',
    '.pa-hd button,.pa-hd input,.pa-hd a,.pa-entry-hd button,.pa-entry-hd input{position:relative;z-index:1}',
    /* 拖起来时给点反馈，明确「拿住了」 */
    '.pa-panel.pa-dragging,.pa-entry.pa-dragging{box-shadow:0 8px 16px rgba(16,24,40,.10),' +
      '0 24px 56px rgba(16,24,40,.20);transition:none}',
    '.pa-panel.pa-dragging .pa-hd,.pa-entry.pa-dragging .pa-entry-hd{cursor:grabbing}',

    /* 面板骨架 */
    '.pa-panel{width:344px;background:#fff;color:#18181b;border:1px solid #e8eaef;border-radius:14px;' +
      'box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(16,24,40,.10)}',
    '.pa-hd{padding:12px 14px;gap:6px;border-bottom:1px solid #f2f4f7;background:#fff;' +
      'border-radius:14px 14px 0 0}',
    '.pa-hd b{font-weight:600;letter-spacing:-.01em;color:#18181b}',
    '.pa-hd b::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;' +
      'background:#4f46e5;margin-right:7px;vertical-align:1px}',
    '.pa-n{background:#f4f4f5;color:#52525b;border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:500}',
    '.pa-ic{border:1px solid #e4e7ec;background:#fff;color:#71717a;border-radius:8px;' +
      'transition:background .12s,color .12s,border-color .12s}',
    '.pa-ic:hover{background:#f4f4f5;color:#18181b;border-color:#d4d4d8}',
    /* 头部图标统一留位，避免「?」和相邻按钮大小不一导致头部抖动 */
    '.pa-hd .pa-ic,.pa-help{width:26px;height:26px}',

    /* 主按钮：近黑，克制 */
    '.pa-bar{padding:12px 14px;border-bottom:1px solid #f2f4f7}',
    '.pa-go{background:#18181b;color:#fff;border-radius:10px;font-weight:500;letter-spacing:.01em;' +
      'transition:background .12s}',
    '.pa-go:hover{background:#33333a}',
    '.pa-go.on{background:#dc2626}',
    '.pa-go.on:hover{background:#b91c1c}',

    /* 筛选框 + 开关同一行 */
    '.pa-find{display:flex;align-items:center;gap:8px;padding:10px 12px 0;background:#fff}',
    '.pa-find input{flex:1;min-width:0;box-sizing:border-box;border:1px solid #e4e7ec;border-radius:9px;' +
      'padding:7px 10px;font:12.5px/1.5 inherit;color:#18181b;background:#fff;' +
      'transition:border-color .12s,box-shadow .12s}',
    '.pa-find input::placeholder{color:#a1a1aa}',
    '.pa-find input:focus{outline:none;border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.10)}',

    /* 列表 */
    '.pa-list{flex:1;overflow-y:auto;padding:10px 12px 12px;background:#fafafa}',
    '.pa-list::-webkit-scrollbar{width:8px}',
    '.pa-list::-webkit-scrollbar-thumb{background:#e4e4e7;border-radius:8px;border:2px solid #fafafa}',
    '.pa-list::-webkit-scrollbar-thumb:hover{background:#d4d4d8}',
    '.pa-grp{font:600 11px/1.6 inherit;color:#a1a1aa;padding:8px 2px 6px;letter-spacing:.04em}',
    '.pa-item{background:#fff;border:1px solid #eceef2;border-radius:10px;padding:10px 11px;' +
      'margin-bottom:8px;transition:border-color .12s,box-shadow .12s}',
    '.pa-item:hover{border-color:#dcdfe6;box-shadow:0 1px 2px rgba(16,24,40,.04)}',
    '.pa-meta{gap:7px;margin-bottom:7px;align-items:flex-start}',
    '.pa-tag{background:#eef2ff;color:#4f46e5;border-radius:5px;font-weight:600;padding:0 6px;margin-top:1px}',
    /* 路径独占整行（flex:1 才不会把删除按钮挤到行尾），超长截断而不是撑高 */
    '.pa-path{color:#71717a;font-size:11px;flex:1;min-width:0;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;display:block;padding-top:1px}',
    '.pa-path[title]{cursor:help}',
    '.pa-del{color:#a1a1aa;border-radius:6px;flex:0 0 auto;font-size:14px;line-height:1;' +
      'padding:1px 5px;transition:color .12s,background .12s}',
    '.pa-del:hover{color:#dc2626;background:#fef2f2}',

    /* vendor 的 textarea 没写 background，会被页面全局 input 规则喂成深色，这里钉死白底 */
    '.pa-item textarea{background:#fff;color:#18181b;border:1px solid #e4e7ec;border-radius:8px;' +
      'padding:7px 9px;font:12.5px/1.6 inherit;transition:border-color .12s,box-shadow .12s}',
    '.pa-item textarea::placeholder{color:#a1a1aa}',
    '.pa-item textarea:focus{outline:none;border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.10)}',
    '.pa-item[hidden]{display:none!important}',
    '.pa-empty{color:#a1a1aa;padding:36px 16px;font-size:12.5px}',

    /* 底栏：复制 + 下载并排 */
    '.pa-ft{border-top:1px solid #f2f4f7;padding:10px 14px;background:#fff;display:flex;gap:8px}',
    '.pa-exp{flex:1;border:1px solid #18181b;background:#18181b;color:#fff;border-radius:10px;' +
      'font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .12s}',
    '.pa-exp:hover{background:#33333a}',
    '.pa-dl{flex:0 0 auto;border:1px solid #e4e7ec;background:#fff;color:#52525b;border-radius:10px;' +
      'padding:9px 12px;font:500 13px inherit;cursor:pointer;display:flex;align-items:center;gap:6px;' +
      'transition:background .12s,border-color .12s}',
    '.pa-dl:hover{background:#f4f4f5;border-color:#d4d4d8}',

    /* 清空二次确认：待确认态转警示红，并用 ::after 在按钮下方浮出「再点一次确认」。
       清空按钮是图标按钮，所以文案只能走伪元素，不能改 textContent。
       提示放下方而不是上方 —— 上方会被面板头栏和关闭按钮压住。 */
    '.pa-ic[data-clear-armed]{background:#fef2f2;border-color:#fca5a5;color:#dc2626;position:relative}',
    '.pa-ic[data-clear-armed]:hover{background:#fee2e2;border-color:#f87171}',
    '.pa-ic[data-clear-armed]::after{content:"再点一次确认";position:absolute;left:50%;top:calc(100% + 9px);' +
      'transform:translateX(-50%);white-space:nowrap;background:#dc2626;color:#fff;font:500 11.5px inherit;' +
      'padding:4px 9px;border-radius:6px;letter-spacing:.02em;pointer-events:none;z-index:2147483646;' +
      'box-shadow:0 4px 12px rgba(220,38,38,.28)}',
    '.pa-ic[data-clear-armed]::before{content:"";position:absolute;left:50%;top:calc(100% + 5px);' +
      'transform:translateX(-50%) rotate(45deg);width:7px;height:7px;background:#dc2626;' +
      'pointer-events:none;z-index:2147483647}',

    /* 开关：跟在筛选框后面；拨钮本身无文字，用 title 说明，勾选态在「?」里有解释 */
    '.pa-xtra{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:0 2px 0 0}',
    '.pa-xtra label{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}',
    '.pa-xtra .pa-xtra-t{font-size:11.5px;color:#a1a1aa;white-space:nowrap;cursor:help}',
    '.pa-xtra input:checked+.pa-xtra-t{color:#4f46e5}',    '.pa-xtra input{appearance:none;-webkit-appearance:none;width:32px;height:18px;border-radius:17px;' +
      'background:#e4e4e7;position:relative;cursor:pointer;margin:0;flex:0 0 auto;' +
      'transition:background .15s;outline:none}',
    '.pa-xtra input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;' +
      'border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}',
    '.pa-xtra input:checked{background:#4f46e5}',
    '.pa-xtra input:checked::after{left:16px}',

    /* 头部「?」帮助按钮 + 弹层 */
    '.pa-help{width:22px;height:22px;border-radius:50%;border:1px solid #e4e7ec;padding:0;' +
      'background:#fff;color:#71717a;font:600 12px/1 inherit;cursor:pointer;display:grid;' +
      'place-items:center;flex:0 0 auto;transition:background .12s,color .12s,border-color .12s}',
    '.pa-help:hover,.pa-help.on{color:#4f46e5;border-color:#c7d2fe;background:#eef2ff}',
    /* 弹层贴在「?」下方。面板是 overflow:hidden，top 必须为正，否则顶部被裁。
       同时把主按钮压暗，视觉上让位给说明层。 */
    '.pa-help-pop{position:absolute;top:6px;right:8px;width:268px;background:#fff;' +
      'border:1px solid #e8eaef;border-radius:12px;box-shadow:0 12px 32px rgba(16,24,40,.14);' +
      'padding:13px 14px;display:none;z-index:5;font-size:12px;line-height:1.7;color:#3f3f46}',
    '.pa-panel:has(.pa-help-pop.on) .pa-bar{opacity:.3;pointer-events:none;transition:opacity .12s}',
    '.pa-help-pop.on{display:block}',
    '.pa-help-pop h4{margin:0 0 6px;font-size:12.5px;font-weight:600;color:#18181b}',
    '.pa-help-pop p{margin:0 0 8px;color:#71717a}',
    '.pa-help-pop ul{margin:0 0 10px;padding-left:16px;color:#71717a}',
    '.pa-help-pop li{margin:3px 0}',
    '.pa-help-pop b{color:#27272a;font-weight:600}',
    '.pa-help-pop .pa-keys{display:flex;flex-direction:column;gap:6px;border-top:1px solid #f2f4f7;' +
      'padding-top:10px}',
    '.pa-help-pop .pa-keys>div{display:flex;align-items:center;justify-content:space-between;gap:10px;' +
      'color:#71717a}',
    '.pa-help-pop kbd{background:#f4f4f5;border:1px solid #e4e7ec;border-radius:4px;padding:0 5px;' +
      'font:11px/1.7 ui-monospace,Menlo,monospace;color:#3f3f46}',

    /* 钉子 / 悬停高亮 / 悬浮球 */
    '.pa-pin{background:#4f46e5;color:#fff;border:2px solid #fff;font-weight:600;' +
      'box-shadow:0 2px 8px rgba(79,70,229,.4)}',
    '.pa-hl{border-color:#4f46e5;background:rgba(79,70,229,.07);border-radius:4px}',
    '.pa-fab{background:#4f46e5;color:#fff;border-radius:14px;width:44px;height:44px;' +
      'box-shadow:0 6px 18px rgba(79,70,229,.38);transition:transform .15s,box-shadow .15s}',
    '.pa-fab:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(79,70,229,.42)}',

    /* 提示条 / Toast：小药丸 */
    '.pa-hint{background:#18181b;border-radius:999px;font-size:12px;padding:7px 14px;letter-spacing:.01em}',
    '#pa-toast,#pa-toast-extra{border-radius:999px!important;background:#18181b!important;font-size:12.5px!important}',

    /* 就地登记弹层：贴着被点的元素，Codex 式 */
    '.pa-entry{position:fixed;width:288px;background:#fff;border:1px solid #e8eaef;border-radius:12px;' +
      'box-shadow:0 1px 2px rgba(16,24,40,.04),0 16px 40px rgba(16,24,40,.16);z-index:2147483647;' +
      'padding:10px;display:none}',
    '.pa-entry-hd{display:flex;align-items:center;gap:8px;margin-bottom:7px}',
    '.pa-entry-t{flex:1;min-width:0;font:500 11.5px/1.5 ui-monospace,Menlo,monospace;color:#71717a;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pa-entry-x{border:0;background:none;color:#a1a1aa;cursor:pointer;font-size:16px;line-height:1;' +
      'padding:0 4px;border-radius:5px}',
    '.pa-entry-x:hover{color:#dc2626;background:#fef2f2}',
    '.pa-entry textarea{width:100%;box-sizing:border-box;border:1px solid #e4e7ec;border-radius:8px;' +
      'padding:7px 9px;font:12.5px/1.6 inherit;color:#18181b;background:#fff;resize:vertical;min-height:60px;' +
      'transition:border-color .12s,box-shadow .12s}',
    '.pa-entry textarea::placeholder{color:#a1a1aa}',
    '.pa-entry textarea:focus{outline:none;border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.10)}',
    '.pa-entry-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}',
    '.pa-entry-tip{font-size:11px;color:#a1a1aa}',
    '.pa-entry-ok{border:0;background:#18181b;color:#fff;border-radius:8px;padding:6px 14px;' +
      'font:500 12.5px inherit;cursor:pointer;transition:background .12s}',
    '.pa-entry-ok:hover{background:#33333a}'
  ].join('');

  var HELP_HTML =
    '<h4>页面标注</h4>' +
    '<p>点页面元素登记需求，写完就回到待命，不打断你正常操作页面。' +
    '所有条目按板块分别保存，可一键导出 Markdown 给开发或 AI。</p>' +
    '<ul>' +
    '<li>点<b>「开始标注」</b>后，鼠标移到哪就高亮哪</li>' +
    '<li>点中元素 → <b>原地弹出输入框</b>，敲需求，<kbd>Enter</kbd> 提交</li>' +
    '<li>提交后自动结束标注，页面立刻恢复可点；钉子留在元素上</li>' +
    '<li>想放弃刚标的这条，<kbd>Esc</kbd> 或点输入框外面</li>' +
    '<li>右侧列表可回看、补写、删除；上方筛选框按文字与意见过滤</li>' +
    '<li>筛选框右侧的<b>「连续标注」</b>：开启后登记完不退出，可接着点下一个元素</li>' +
    '<li><b>面板和弹窗都能拖着走</b>：按住顶部标题栏即可拖到顺手的位置</li>' +
    '</ul>' +
    '<div class="pa-keys">' +
    '<div><span>临时穿透，正常操作页面</span><span><kbd>Alt</kbd> 按住</span></div>' +
    '<div><span>结束标注</span><span><kbd>Esc</kbd></span></div>' +
    '<div><span>开始 / 结束标注</span><span><kbd>Shift</kbd>+<kbd>A</kbd></span></div>' +
    '</div>';

  /* ---------------- 面板增强 ---------------- */
  function enhancePanel() {
    var panel = document.querySelector('.pa-panel');
    if (!panel) return false;
    if (panel.querySelector('[data-pa-extra]')) return true;
    var bar = panel.querySelector('.pa-bar');
    if (!bar) return false;

    if (!document.getElementById('pa-extra-style')) {
      var s = document.createElement('style');
      s.id = 'pa-extra-style';
      s.textContent = THEME_CSS;
      (document.head || document.documentElement).appendChild(s);
      POP_CSS_READY = true;
    }

    /* 筛选框 + 自动暂停开关：同一行，放在列表上方 */
    var find = document.createElement('div');
    find.className = 'pa-find';
    find.setAttribute('data-pa', '');
    find.innerHTML = '<input type="search" data-find placeholder="筛选标注…">';

    /* 开关：说明文字收进「?」，这里只留拨钮 + 一行灰字标签 */
    var box = document.createElement('div');
    box.className = 'pa-xtra';
    box.setAttribute('data-pa', '');          // 和 vendor 的 el() 一样，排除"标注到自己"
    box.setAttribute('data-pa-extra', '');
    box.innerHTML =
      '<label title="连续标注：登记完不退出，可以接着点下一个元素；关掉则登记完自动回到待命">' +
      '<input type="checkbox" data-continuous><span class="pa-xtra-t">连续标注</span></label>';
    find.appendChild(box);

    var cb = box.querySelector('[data-continuous]');
    cb.checked = continuous;
    cb.addEventListener('change', function () {
      continuous = cb.checked;
      toast(continuous ? '连续标注：登记完不退出' : '登记完自动回到待命');
    });

    var list = panel.querySelector('[data-list]');
    panel.insertBefore(find, list);
    var findInput = find.querySelector('[data-find]');

    /* 面板可拖动：头部整条当把手，位置存 sessionStorage（刷新页面仍在）。
       面板是常驻控件，被用户摆在顺手的地方就该一直待在那儿。 */
    var hd = panel.querySelector('.pa-hd');
    if (hd) {
      makeDraggable(panel, hd, { persist: true });
      restorePos(panel);
    }

    /* 下载按钮：与「复制反馈」并排 */
    var ft = panel.querySelector('.pa-ft');
    var dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'pa-dl';
    dl.title = '下载 Markdown 文件';
    dl.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">' +
      '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>下载';
    dl.addEventListener('click', function () {
      var md = buildMarkdown();
      if (!md) { toast('还没有标注'); return; }
      forceDownload(md);
      toast('已下载 Markdown 文件');
    });
    ft.appendChild(dl);

    /* 头部「?」帮助按钮：插在清空按钮前面 */
    var hd = panel.querySelector('.pa-hd');
    var helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.className = 'pa-help';
    helpBtn.title = '使用说明';
    helpBtn.textContent = '?';
    helpBtn.setAttribute('data-pa', '');
    hd.insertBefore(helpBtn, hd.querySelector('[data-clear]'));

    var pop = document.createElement('div');
    pop.className = 'pa-help-pop';
    pop.setAttribute('data-pa', '');
    pop.innerHTML = HELP_HTML;
    panel.appendChild(pop);

    helpBtn.addEventListener('click', function () {
      var open = !pop.classList.contains('on');
      pop.classList.toggle('on', open);
      helpBtn.classList.toggle('on', open);
    });
    document.addEventListener('click', function (e) {
      if (!pop.classList.contains('on')) return;
      if (pop.contains(e.target) || helpBtn.contains(e.target)) return;
      pop.classList.remove('on');
      helpBtn.classList.remove('on');
    }, true);

    /* 清空 + 导出：捕获阶段在面板层拦下（先于 vendor 绑在按钮上的目标监听）。
       清空升级为"清全部视图"，与聚合面板一致；
       导出接管是为了绕开 vendor 用桶键当标题的问题。 */
    if (!panel.getAttribute('data-pa-hooked')) {
      panel.setAttribute('data-pa-hooked', '1');
      panel.addEventListener('click', function (e) {
        var t = e.target && e.target.nodeType === 1 ? e.target.closest('[data-clear],[data-export]') : null;
        if (!t) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (t.hasAttribute('data-clear')) onClearClick(t);
        else exportMd();
      }, true);
    }

    /* 待确认态下点了面板别处 → 取消本次清空，避免用户自己把按钮点了又不确定。*/
    if (!panel.getAttribute('data-clear-hooked')) {
      panel.setAttribute('data-clear-hooked', '1');
      panel.addEventListener('click', function (e) {
        var armed = panel.querySelector('[data-clear][data-clear-armed]');
        if (!armed) return;
        var t = e.target && e.target.nodeType === 1 ? e.target.closest('[data-clear]') : null;
        if (t === armed) return;         // 这次就是点它，交给上面处理
        resetClearArm(armed);
      });
    }

    /* 面板每次重绘（list() 是全量重建）后：把内部键改写成视图中文名，并重挂筛选。
       分组头文本可能带「（N）」后缀，所以用 startsWith 比对 PAGE_KEY 而不是 charAt(0)==='/'。
       列表重绘不影响用户正在输入的意见框（vendor 有 selfWrites 去重）。 */
    if (list && typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        list.querySelectorAll('.pa-grp').forEach(function (g) {
          if (g.textContent.indexOf(PAGE_KEY) !== 0) return;
          g.textContent = currentViewName() + g.textContent.slice(PAGE_KEY.length);
        });
        applyFilter();
      }).observe(list, { childList: true });
    }

    findInput.addEventListener('input', applyFilter);
    findInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var first = list.querySelector('.pa-item:not([hidden]) textarea');
      if (first) first.focus();
    });

    function applyFilter() {
      var q = (findInput.value || '').trim().toLowerCase();
      list.querySelectorAll('.pa-item').forEach(function (it) {
        if (!q) { it.hidden = false; return; }
        /* 意见写在 textarea.value 里，不进 textContent，必须单独拼进来，
           否则「按意见筛选」永远搜不到。 */
        var hay = it.textContent;
        var ta = it.querySelector('textarea');
        if (ta) hay += ' ' + (ta.value || '');
        it.hidden = hay.toLowerCase().indexOf(q) < 0;
      });
      var groups = list.querySelectorAll('.pa-grp');
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i], sib = g.nextElementSibling, any = false;
        while (sib && !sib.classList.contains('pa-grp')) {
          if (sib.classList.contains('pa-item') && !sib.hidden) { any = true; break; }
          sib = sib.nextElementSibling;
        }
        g.hidden = !any;
      }
    }

    var hint = document.querySelector('.pa-hint');
    if (hint) hint.textContent = HINT_ON;

    /* 每次重新进入标注模式都把提示条刷回标准文案
       （toast 期间临时写过别的字，超时后复原）。 */
    var startBtn = panel.querySelector('[data-start]');
    if (startBtn && !panel.getAttribute('data-pa-hint-hooked')) {
      panel.setAttribute('data-pa-hint-hooked', '1');
      startBtn.addEventListener('click', function () {
        setTimeout(function () {
          var h = document.querySelector('.pa-hint');
          if (h && h.classList.contains('on')) h.textContent = HINT_ON;
        }, 0);
      });
    }

    /* vendor 把开关按钮文案写成「开始标注 / 结束标注（Esc）」。
       在这套交互里"结束"其实是"回到待命、页面恢复可点"，说清楚更贴切。
       vendor 的 syncBtn 会改 textContent，所以监听它替换的那次 mutation 并跟随改写。 */
    if (!panel.getAttribute('data-pa-btntext-hooked')) {
      panel.setAttribute('data-pa-btntext-hooked', '1');
      var relabel = function () {
        var want = startBtn.classList.contains('on')
          ? '结束标注，回到待命' : '开始标注';
        if (startBtn.textContent !== want) startBtn.textContent = want;
      };
      /* 监听 class 变化（vendor 的 syncBtn 会先改 class 再改 textContent，
         监听 childList 会被自己触发的写入带着绕，改成只跟 class + 点击后补一次） */
      new MutationObserver(relabel).observe(startBtn, { attributes: true, attributeFilter: ['class'] });
      startBtn.addEventListener('click', function () { setTimeout(relabel, 0); });
      relabel();
    }
    return true;
  }

  function forceDownload(text) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '页面标注反馈-' + stamp().replace(/[-: ]/g, '') + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /** 插件的 buildPanel 在 boot() 里才跑，本 shim 先执行，所以面板要等它出现。 */
  function watchPanel() {
    if (enhancePanel()) return;
    if (typeof MutationObserver !== 'function') {
      var timer = setInterval(function () { if (enhancePanel()) clearInterval(timer); }, 200);
      setTimeout(function () { clearInterval(timer); }, 8000);
      return;
    }
    var mo = new MutationObserver(function () {
      if (enhancePanel()) mo.disconnect();
    });
    if (document.body) mo.observe(document.body, { childList: true });
    else document.addEventListener('DOMContentLoaded', function () { mo.observe(document.body, { childList: true }); });
  }

  function toast(msg) {
    /* 标注模式下底部已有 .pa-hint 提示条，再弹一个 toast 会视觉打架。
       这类反馈改写提示条自身的文字，过 2.4 秒后由 syncHint 复原。 */
    var hint = document.querySelector('.pa-hint');
    if (hint && hint.classList.contains('on')) {
      hint.textContent = msg;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(syncHint, 2400);
      return;
    }
    var t = document.getElementById('pa-toast-extra');
    if (!t) {
      t = document.createElement('div');
      t.id = 'pa-toast-extra';
      t.setAttribute('data-pa', '');
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:104px;z-index:2147483647;' +
        'background:#18181b;color:#fff;padding:8px 16px;border-radius:999px;font:12.5px/1.5 ' +
        '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;display:none';
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2600);
  }

  function syncHint() {
    var h = document.querySelector('.pa-hint');
    if (!h) return;
    // 标注已结束时 vendor 会摘掉 .on，此时不该再写文字（下次开启时由 enhancePanel 复原）
    if (h.classList.contains('on')) h.textContent = HINT_ON;
  }

  /* 面板收起后没有可见的「继续标注」入口（FAB 只管开关面板）。
     Shift+A 开关标注模式，走插件自己的按钮，不重复实现 setMode。
     可编辑元素里不抢键；修饰键只加 Shift，避免和 Alt 穿透语义打架。 */
  function isEditable(t) {
    if (!t || t.nodeType !== 1) return false;
    var tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  document.addEventListener('keydown', function (e) {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'A' && e.key !== 'a') return;
    if (isEditable(e.target)) return;
    var btn = document.querySelector('.pa-panel [data-start]');
    if (!btn) return;
    e.preventDefault();
    btn.click();
    /* 文案别用 toast 打断开启流程：刚开启时提示条正显示，toast 会盖住它。
       只在"关掉"时给一次确认，开启交给提示条自己说话。 */
    if (!btn.classList.contains('on')) toast('已结束标注，页面恢复可点');
  }, true);

  /* Chrome 浏览器里 window.chrome 已存在但页面上下文没有 .storage，逐层补齐即可 */
  var c = window.chrome = window.chrome || {};
  c.storage = c.storage || {};
  if (!c.storage.local) c.storage.local = store;
  c.storage.onChanged = c.storage.onChanged || {};
  c.storage.onChanged.addListener = function (fn) {
    if (typeof fn === 'function') changeListeners.push(fn);
  };
  c.runtime = c.runtime || {};
  if (!c.runtime.onMessage) c.runtime.onMessage = { addListener: function () {} };

  /* ---------------- 视图切换 → 让插件重读重画 ---------------- */
  function startWatch() {
    if (!document.body || typeof MutationObserver !== 'function') return;
    var lastView = currentView();
    new MutationObserver(function () {
      var v = currentView();
      if (v === lastView) return;
      lastView = v;
      emitPinChange();
      // 切走了：新视图的元素坐标全变了，必须把本页桶里的钉子挪回它该在的地方。
      // 等一帧再跑 —— 视图刚切时 DOM 还没重建完，立刻量 rect 会量到 0。
      setTimeout(function () { repositionPins(v); }, 60);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  }
  startWatch();
  watchPanel();
  startRepositionWatch();

  /* ---------------- 钉子重新定位（2026-10-11佘总反馈）
     问题：钉子位置存的是**文档绝对坐标**（点下去那一刻的 rect + scroll），
     vendor 的 paintPins 直接照着画。切到另一个视图后，元素早换了位置，
     钉子却还钉在旧坐标上 —— 表现就是「切换页面还能看到原来位置的钉」。
     办法：每条 pin 都存了 cssPath，切视图后拿它重新 querySelector 找元素，
     找到就按元素当前 rect 重算坐标并写回；找不到（元素真没了）就退回到
     旧坐标，不乱跳。
     ========================================================================== */

  /** cssPath → 元素。vendor 生成的是标准可解析路径，直接 querySelector 即可。 */
  function resolveByPath(cssPath) {
    if (!cssPath) return null;
    try { return document.querySelector(cssPath); }
    catch (e) { return null;          // 路径非法（别名前缀等）→ 当没找到
    }
  }

  /** 把钉子层里的 DOM 钉子清空，逼 vendor 下次 paint 重建。
      切视图时必须做：vendor 的 onChanged 里有 selfWrites 去重，
      可能把「换个视图」误判成「自己刚写的」而跳过重画，
      结果上一个视图的钉子就挂在新页面上。直接清层最稳，不跟那套去重逻辑掰扯。*/
  function clearPinLayer() {
    document.querySelectorAll('.pa-pin').forEach(function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
  }

  /* view 参数保留是为了调用点语义清晰（都传当前视图），
     但实际取桶走 toStorageKey 内部路由，避免两处逻辑漂移。 */
  function repositionPins(view) { /* jshint unused:false */
    // 先把上一视图残留的钉子从 DOM 清掉：vendor 那套 selfWrites 去重
    // 可能把「切视图」误判成「自己写的」而跳过重画，不清就会挂在新页面上。
    clearPinLayer();

    /* 用 toStorageKey 走统一路由，别手拼 —— 单视图模式下 vendor 的桶键是
       pa:pins: + 真实路径（不一定是 /），手拼 '/' 会读错桶导致钉子重定位不到。 */
    var key = currentBucket();

    var list;
    try { list = JSON.parse(localStorage.getItem(key)) || []; }
    catch (e) { return; }
    if (!list.length) return;

    // 按 cssPath 重新定位：钉子坐标存的是标注那一刻的文档坐标，
    // 换个视图元素早挪位了，不重算就会看到「钉子留在老地方」。
    list.forEach(function (p) {
      if (!p) return;
      var el = resolveByPath(p.cssPath);
      if (!el || !el.getBoundingClientRect) return;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;      // 元素不可见（display:none），先别动
      p.x = Math.round(r.left + window.scrollX + Math.min(r.width / 2, 24));
      p.y = Math.round(r.top + window.scrollY + Math.min(r.height / 2, 24));
    });

    try { localStorage.setItem(key, JSON.stringify(list)); }
    catch (e) { /* 存不进去也照样画，只是下次还会漂 */ }

    // 钉子层已清空，必须逼 vendor 重画一次。
    // emitPinChange 走的是 vendor 的 onChanged，可能被 selfWrites 去重跳过，
    // 所以这里等它跑完再自查：DOM 里没钉子就自己画。
    emitPinChange();
    setTimeout(function () {
      if (document.querySelectorAll('.pa-pin').length) return;   // vendor 已画好
      repaintPinLayer(list);
    }, 30);
  }

  /** 找 vendor 的钉子层。它没有类名（只有 inline style），靠特征定位。 */
  function pinLayer() {
    var pins = document.querySelectorAll('.pa-pin');
    if (pins.length) return pins[0].parentNode;
    // 一个钉子都没有时，从高亮层 .pa-hl 的父级反推
    var hl = document.querySelector('.pa-hl');
    return hl ? hl.parentNode : null;
  }

  /** 自己画钉子（vendor 没画时的兜底）。编号按桶内顺序，和 vendor 一致。 */
  function repaintPinLayer(list) {
    var layer = pinLayer();
    if (!layer) return;                        // vendor 还没建层，等它
    list.forEach(function (p, i) {
      if (!p) return;
      var n = document.createElement('div');
      n.className = 'pa-pin';
      n.textContent = String(i + 1);
      n.style.left = p.x + 'px';
      n.style.top = p.y + 'px';
      layer.appendChild(n);
    });
  }

  /** 首次进页面 + 窗口缩放后都要重新定位一次（布局变了，坐标就变了）。 */
  function startRepositionWatch() {
    // 布局稳定后再跑首轮，否则元素还没渲染完，量到的 rect 是 0
    if (document.readyState === 'complete') setTimeout(function () { repositionPins(currentView()); }, 800);
    else window.addEventListener('load', function () {
      setTimeout(function () { repositionPins(currentView()); }, 800);
    });

    // 缩放防抖：拖窗口时事件很密，不 debounce 会疯狂写 localStorage
    var rt = null;
    window.addEventListener('resize', function () {
      if (rt) clearTimeout(rt);
      rt = setTimeout(function () { rt = null; repositionPins(currentView()); }, 350);
    });
  }
})();