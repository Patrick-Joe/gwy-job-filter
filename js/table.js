/* =========================================================================
 * ResultTable — 高性能结果表格组件（Agent D）
 *
 * 契约（见 SPEC.md「模块接口契约」）：
 *   ResultTable.init(containerEl, { onRowClick })
 *   ResultTable.setData(entries)  // entries: [{ job, result, rawText }]，result 可为 null（raw 模式）
 *
 * 功能（SPEC 要求逐项对应）：
 *   - 匹配状态列固定在最左：✅绿 / ❌红 / ⚠️黄 徽标，title 悬浮显示原因摘要，横向滚动时 sticky 不消失
 *   - 分页：50 / 100 / 200 可选，带首页/上一页/下一页/末页/跳页
 *   - 排序：点击表头 升序 → 降序 → 取消；Shift+点击 叠加多列排序（标记 ▲1 ▼2 显示优先级）
 *   - 每列顶部关键词过滤输入（大小写不敏感子串，列间 AND，200ms 防抖）
 *   - 状态列配状态下拉过滤（全部/✅/⚠️/❌/—）
 *   - 横向滚动 + sticky 表头（标题行与过滤行两级 sticky，偏移量由 JS 实测行高）
 *   - 长文本截断：title 悬浮全文 + 点击单元格展开/收起
 *   - 行点击回调 onRowClick(entry)：点击非截断单元格或状态徽标时触发
 *   - 渲染分块：DocumentFragment + 每 200 行 setTimeout 让出主线程；
 *     过滤计算同样分块（每 1000 行让出），1.9 万行不卡 UI
 *
 * 说明：
 *   - 纯 UI 模块，仅浏览器可用（node 加载不报错，但不要调用 init）。
 *   - DOM 结构与 class 命名（rt-* 前缀）由本模块自定；正式样式由 css/style.css（Agent C）提供，
 *     本文件不含任何样式。class 清单见 test/table.test.html 顶部注释。
 *   - rawText 字段保留在 entry 上但不参与渲染（列从 entry.job 的键并集派生，原始列全部展示）。
 * ====================================================================== */
(function (g) {
  'use strict';

  var PAGE_SIZES = [50, 100, 200];
  var RENDER_CHUNK = 200;   /* 每渲染 200 行让出主线程（SPEC 要求） */
  var FILTER_CHUNK = 1000;  /* 每过滤 1000 行让出主线程（SPEC 全局要求 500~1000） */
  var DEBOUNCE_MS = 200;

  var STATUS_META = {
    match:   { badge: '✅', label: '符合',   cls: 'match'   },
    nomatch: { badge: '❌', label: '不符合', cls: 'nomatch' },
    unknown: { badge: '⚠️', label: '需核实', cls: 'unknown' },
    none:    { badge: '—',  label: '未匹配', cls: 'none'    }
  };

  /* ---------------- 内部状态（单例） ---------------- */
  var S = {
    inited: false,
    container: null,
    onRowClick: null,
    entries: [],       /* setData 传入的全量 */
    columns: [],       /* 从 entries 的 job 键并集派生（保持出现顺序） */
    filters: {},       /* 列名 -> 关键词 */
    statusFilter: '',  /* '' | match | nomatch | unknown | none */
    sorts: [],         /* [{col, dir:1|-1}]，按下标为优先级 */
    page: 1,
    pageSize: PAGE_SIZES[0],
    view: [],          /* 过滤 + 排序后的 entries */
    pageRows: [],      /* 当前页切片的 entries（供行点击回调索引） */
    token: 0,          /* 代际计数：过期的异步计算/渲染自动作废 */
    filterTimer: null,
    resizeTimer: null,
    els: {}            /* DOM 引用 */
  };

  /* ---------------- 工具 ---------------- */

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function closest(node, sel) {
    while (node && node.nodeType === 1) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* ---------------- 初始化 ---------------- */

  function init(containerEl, opts) {
    if (typeof document === 'undefined') throw new Error('[ResultTable] 仅浏览器环境可用');
    if (!containerEl || !containerEl.nodeType) throw new Error('[ResultTable] init: containerEl 无效');
    S.container = containerEl;
    S.onRowClick = opts && typeof opts.onRowClick === 'function' ? opts.onRowClick : null;
    S.onStatusFilterChange = opts && typeof opts.onStatusFilterChange === 'function' ? opts.onStatusFilterChange : null;
    S.entries = [];
    S.columns = [];
    S.filters = {};
    S.statusFilter = '';
    S.sorts = [];
    S.page = 1;
    S.pageSize = PAGE_SIZES[0];
    S.view = [];
    S.pageRows = [];
    S.token++;
    buildShell();
    S.inited = true;
    buildHeader();
    update();
  }

  function pageSizeOptions() {
    var out = '';
    for (var i = 0; i < PAGE_SIZES.length; i++) {
      out += '<option value="' + PAGE_SIZES[i] + '">' + PAGE_SIZES[i] + '</option>';
    }
    return out;
  }

  /* 静态骨架（无用户数据插值，安全） */
  function buildShell() {
    S.container.innerHTML =
      '<div class="rt-root">' +
        '<div class="rt-toolbar">' +
          '<span class="rt-count"></span>' +
          '<label class="rt-pagesize-label">每页' +
            '<select class="rt-pagesize">' + pageSizeOptions() + '</select>条' +
          '</label>' +
        '</div>' +
        '<div class="rt-scroll">' +
          '<table class="rt-table">' +
            '<thead class="rt-head"></thead>' +
            '<tbody class="rt-body"></tbody>' +
          '</table>' +
        '</div>' +
        '<div class="rt-pager">' +
          '<button type="button" class="rt-page-btn" data-act="first" title="第一页">«</button>' +
          '<button type="button" class="rt-page-btn" data-act="prev" title="上一页">‹</button>' +
          '<span class="rt-page-info"></span>' +
          '<button type="button" class="rt-page-btn" data-act="next" title="下一页">›</button>' +
          '<button type="button" class="rt-page-btn" data-act="last" title="最后一页">»</button>' +
          '<span class="rt-jump-wrap">跳至' +
            '<input type="number" class="rt-page-jump" min="1">页' +
            '<button type="button" class="rt-page-btn rt-jump-go">确定</button>' +
          '</span>' +
        '</div>' +
      '</div>';

    S.els.root = S.container.querySelector('.rt-root');
    S.els.count = S.container.querySelector('.rt-count');
    S.els.pageSizeSel = S.container.querySelector('.rt-pagesize');
    S.els.thead = S.container.querySelector('.rt-head');
    S.els.tbody = S.container.querySelector('.rt-body');
    S.els.pager = S.container.querySelector('.rt-pager');
    S.els.pageInfo = S.container.querySelector('.rt-page-info');
    S.els.jumpInput = S.container.querySelector('.rt-page-jump');

    S.els.pageSizeSel.value = String(S.pageSize);
    S.els.pageSizeSel.addEventListener('change', function () {
      S.pageSize = parseInt(S.els.pageSizeSel.value, 10) || PAGE_SIZES[0];
      S.page = 1;
      update();
    });
    /* 表头事件全部委托在持久的 thead 上（表头内容随 setData 重建也不受影响） */
    S.els.thead.addEventListener('click', onHeadClick);
    S.els.thead.addEventListener('input', onHeadInput);
    S.els.thead.addEventListener('change', onHeadChange);
    S.els.tbody.addEventListener('click', onBodyClick);
    S.els.pager.addEventListener('click', onPagerClick);
    S.els.jumpInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) doJump();
    });
  }

  function onResize() {
    clearTimeout(S.resizeTimer);
    S.resizeTimer = setTimeout(syncStickyOffsets, 150);
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', onResize);
  }

  /* ---------------- 表头 ---------------- */

  function buildHeader() {
    var head = S.els.thead;
    head.innerHTML = '';

    var trH = el('tr', 'rt-head-row');
    trH.appendChild(el('th', 'rt-th rt-th-status', '状态'));
    var i;
    for (i = 0; i < S.columns.length; i++) {
      var th = el('th', 'rt-th rt-th-sortable');
      th.setAttribute('data-col', S.columns[i]);
      th.title = '点击排序（升序 → 降序 → 取消）；Shift+点击叠加多列排序';
      th.appendChild(el('span', 'rt-th-name', S.columns[i]));
      th.appendChild(el('span', 'rt-sort-mark'));
      trH.appendChild(th);
    }
    head.appendChild(trH);

    var trF = el('tr', 'rt-filter-row');
    var thFS = el('th', 'rt-th-filter rt-th-status');
    var sel = el('select', 'rt-status-filter');
    sel.title = '按匹配状态过滤';
    sel.innerHTML =
      '<option value="">全部状态</option>' +
      '<option value="match">✅ 符合</option>' +
      '<option value="unknown">⚠️ 需核实</option>' +
      '<option value="nomatch">❌ 不符合</option>' +
      '<option value="none">— 未匹配</option>';
    sel.value = S.statusFilter;
    thFS.appendChild(sel);
    trF.appendChild(thFS);
    for (i = 0; i < S.columns.length; i++) {
      var thf = el('th', 'rt-th-filter');
      var inp = el('input', 'rt-filter-input');
      inp.type = 'search';
      inp.placeholder = '过滤…';
      inp.setAttribute('data-col', S.columns[i]);
      inp.value = S.filters[S.columns[i]] || '';
      thf.appendChild(inp);
      trF.appendChild(thf);
    }
    head.appendChild(trF);
    syncStickyOffsets();
  }

  /* 两级 sticky 表头：过滤行的 top = 标题行实测高度（字体/内边距由正式样式决定，实测最稳） */
  function syncStickyOffsets() {
    if (!S.inited || !S.els.thead) return;
    var run = function () {
      var row = S.els.thead.querySelector('.rt-head-row');
      if (!row) return;
      var h = row.offsetHeight;
      var cells = S.els.thead.querySelectorAll('.rt-filter-row th');
      for (var i = 0; i < cells.length; i++) cells[i].style.top = h + 'px';
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /* ---------------- 数据入口 ---------------- */

  function setData(entries) {
    if (!S.inited) {
      if (typeof console !== 'undefined') console.error('[ResultTable] 请先调用 init(containerEl, opts)');
      return;
    }
    S.entries = Object.prototype.toString.call(entries) === '[object Array]' ? entries : [];
    S.columns = deriveColumns(S.entries);
    /* 新数据集：过滤/排序/页码全部重置，避免旧条件落到不存在的列上 */
    S.filters = {};
    S.statusFilter = '';
    S.sorts = [];
    S.page = 1;
    buildHeader();
    update();
  }

  function deriveColumns(entries) {
    var cols = [];
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
      var job = entries[i] && entries[i].job;
      if (!job) continue;
      var ks = Object.keys(job);
      for (var k = 0; k < ks.length; k++) {
        if (!seen[ks[k]]) { seen[ks[k]] = 1; cols.push(ks[k]); }
      }
    }
    return cols;
  }

  /* ---------------- 过滤 + 排序（分块异步） ---------------- */

  function update() {
    if (!S.inited) return;
    var token = ++S.token;
    S.els.root.classList.add('rt-busy');
    computeView(token).then(function (ok) {
      if (!ok || token !== S.token) return;
      var totalPages = Math.max(1, Math.ceil(S.view.length / S.pageSize));
      if (S.page > totalPages) S.page = totalPages;
      if (S.page < 1) S.page = 1;
      renderPage(token);
    });
  }

  function activeFilterList() {
    var ks = Object.keys(S.filters);
    var out = [];
    for (var i = 0; i < ks.length; i++) {
      var kw = str(S.filters[ks[i]]).trim().toLowerCase();
      if (kw) out.push({ col: ks[i], kw: kw });
    }
    return out;
  }

  function computeView(token) {
    return new Promise(function (resolve) {
      var src = S.entries;
      var out = [];
      var filters = activeFilterList();
      var sf = S.statusFilter;
      var i = 0;
      (function step() {
        if (token !== S.token) { resolve(false); return; } /* 已被更新的操作取代 */
        var end = Math.min(i + FILTER_CHUNK, src.length);
        for (; i < end; i++) {
          var e = src[i];
          if (!e || typeof e !== 'object') continue;
          if (sf) {
            var ov = e.result && e.result.overall ? e.result.overall : 'none';
            if (ov !== sf) continue;
          }
          var pass = true;
          for (var f = 0; f < filters.length; f++) {
            var v = e.job ? str(e.job[filters[f].col]) : '';
            if (v.toLowerCase().indexOf(filters[f].kw) === -1) { pass = false; break; }
          }
          if (pass) out.push(e);
        }
        if (i < src.length) setTimeout(step, 0);
        else { applySort(out); S.view = out; resolve(true); }
      })();
    });
  }

  function applySort(arr) {
    if (!S.sorts.length) return;
    var sorts = S.sorts.slice();
    arr.sort(function (a, b) {
      for (var i = 0; i < sorts.length; i++) {
        var s = sorts[i];
        var va = a && a.job ? str(a.job[s.col]) : '';
        var vb = b && b.job ? str(b.job[s.col]) : '';
        /* numeric:true 让「招考人数」1/2/10 与长数字职位代码按数值语义比较 */
        var cmp = va.localeCompare(vb, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp * s.dir;
      }
      return 0;
    });
  }

  /* ---------------- 渲染（分块） ---------------- */

  function renderPage(token) {
    var body = S.els.tbody;
    body.innerHTML = '';
    var start = (S.page - 1) * S.pageSize;
    S.pageRows = S.view.slice(start, start + S.pageSize);
    updateBar();
    if (!S.pageRows.length) {
      appendEmptyRow(body);
      S.els.root.classList.remove('rt-busy');
      return;
    }
    var i = 0;
    (function step() {
      if (token !== S.token) return; /* 过期渲染直接放弃 */
      var frag = document.createDocumentFragment();
      var end = Math.min(i + RENDER_CHUNK, S.pageRows.length);
      for (; i < end; i++) frag.appendChild(buildRow(S.pageRows[i], i));
      body.appendChild(frag);
      if (i < S.pageRows.length) setTimeout(step, 0);
      else S.els.root.classList.remove('rt-busy');
    })();
  }

  function buildRow(entry, pageIndex) {
    var overall = entry && entry.result && entry.result.overall;
    var meta = STATUS_META[overall] || STATUS_META.none;
    var tr = el('tr', 'rt-row rt-row-' + meta.cls);
    tr.setAttribute('data-i', String(pageIndex));

    var tdStatus = el('td', 'rt-td rt-td-status');
    var badge = el('span', 'rt-badge rt-badge-' + meta.cls, meta.badge);
    badge.title = statusTitle(entry, meta);
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    for (var c = 0; c < S.columns.length; c++) {
      var v = entry && entry.job ? str(entry.job[S.columns[c]]) : '';
      var td = el('td', 'rt-td');
      var cell = el('div', 'rt-cell', v);
      cell.title = v; /* 悬浮显示全文 */
      td.appendChild(cell);
      tr.appendChild(td);
    }
    return tr;
  }

  /* 徽标 title：首行总体结论，其后逐行列出非 match 字段的原因 */
  function statusTitle(entry, meta) {
    var r = entry && entry.result;
    if (!r) return '原始筛选模式：未进行资格匹配';
    var head = meta.badge + ' ' + meta.label;
    var fields = r.fields || {};
    var lines = [];
    var cfg = g.APP_CONFIG || {};
    var coreFields = cfg.CORE_FIELDS || [];
    var seen = {};
    var i, f;
    for (i = 0; i < coreFields.length; i++) {
      seen[coreFields[i].key] = true;
      f = fields[coreFields[i].key];
      if (f && f.status && f.status !== 'match') {
        lines.push(coreFields[i].label + '：' + (f.reason || f.status));
      }
    }
    var ks = Object.keys(fields);
    for (i = 0; i < ks.length; i++) {
      if (seen[ks[i]]) continue;
      f = fields[ks[i]];
      if (f && f.status && f.status !== 'match') {
        lines.push(ks[i] + '：' + (f.reason || f.status));
      }
    }
    return lines.length ? head + '\n' + lines.join('\n') : head + '：全部核心条件符合';
  }

  function appendEmptyRow(body) {
    var tr = el('tr', 'rt-empty-row');
    var td = el('td', 'rt-empty');
    td.setAttribute('colspan', String(Math.max(1, S.columns.length + 1)));
    td.textContent = S.entries.length ? '没有符合当前筛选条件的记录' : '暂无数据，请先导入岗位文件';
    tr.appendChild(td);
    body.appendChild(tr);
  }

  /* ---------------- 工具条 / 分页条刷新 ---------------- */

  function updateBar() {
    var total = S.entries.length;
    var filtered = S.view.length;
    var txt = '共 ' + total.toLocaleString('zh-CN') + ' 条';
    if (filtered !== total) txt += '，筛选后 ' + filtered.toLocaleString('zh-CN') + ' 条';
    S.els.count.textContent = txt;

    var totalPages = Math.max(1, Math.ceil(filtered / S.pageSize));
    S.els.pageInfo.textContent = '第 ' + S.page + ' / ' + totalPages + ' 页';
    S.els.jumpInput.max = String(totalPages);
    S.els.jumpInput.placeholder = String(S.page);

    var btns = S.els.pager.querySelectorAll('button[data-act]');
    var i, act;
    for (i = 0; i < btns.length; i++) {
      act = btns[i].getAttribute('data-act');
      btns[i].disabled =
        (act === 'first' || act === 'prev') ? S.page <= 1 :
        (act === 'next' || act === 'last') ? S.page >= totalPages : false;
    }

    /* 排序标记：▲/▼ + 多列时的优先级序号 */
    var ths = S.els.thead.querySelectorAll('.rt-th-sortable');
    for (i = 0; i < ths.length; i++) {
      var col = ths[i].getAttribute('data-col');
      var mark = ths[i].querySelector('.rt-sort-mark');
      var idx = -1;
      for (var s = 0; s < S.sorts.length; s++) if (S.sorts[s].col === col) { idx = s; break; }
      if (idx === -1) {
        mark.textContent = '';
        ths[i].classList.remove('rt-sorted', 'rt-sorted-asc', 'rt-sorted-desc');
      } else {
        mark.textContent = (S.sorts[idx].dir === 1 ? '▲' : '▼') + (S.sorts.length > 1 ? String(idx + 1) : '');
        ths[i].classList.add('rt-sorted');
        ths[i].classList.toggle('rt-sorted-asc', S.sorts[idx].dir === 1);
        ths[i].classList.toggle('rt-sorted-desc', S.sorts[idx].dir === -1);
      }
    }
    if (S.els.pageSizeSel.value !== String(S.pageSize)) S.els.pageSizeSel.value = String(S.pageSize);
  }

  /* ---------------- 事件 ---------------- */

  function onHeadClick(ev) {
    var th = closest(ev.target, 'th.rt-th-sortable');
    if (!th || !S.els.thead.contains(th)) return;
    var col = th.getAttribute('data-col');
    if (!col) return;
    onSortClick(col, !!(ev.shiftKey));
  }

  function onSortClick(col, additive) {
    var idx = -1;
    for (var i = 0; i < S.sorts.length; i++) if (S.sorts[i].col === col) { idx = i; break; }
    if (!additive) {
      /* 单列循环：无 → 升序 → 降序 → 无 */
      if (idx === -1) S.sorts = [{ col: col, dir: 1 }];
      else if (S.sorts[idx].dir === 1) S.sorts = [{ col: col, dir: -1 }];
      else S.sorts = [];
    } else {
      /* Shift 叠加：新增末尾 / 已有则原地循环 / 降序再点则移除 */
      if (idx === -1) S.sorts.push({ col: col, dir: 1 });
      else if (S.sorts[idx].dir === 1) S.sorts[idx] = { col: col, dir: -1 };
      else S.sorts.splice(idx, 1);
    }
    S.page = 1;
    update();
  }

  function onHeadInput(ev) {
    if (!closest(ev.target, '.rt-filter-input')) return;
    clearTimeout(S.filterTimer);
    S.filterTimer = setTimeout(function () {
      /* 统一从 DOM 同步全部过滤输入，避免共享防抖计时器丢先到的那次输入 */
      var inputs = S.els.thead.querySelectorAll('.rt-filter-input');
      var filters = {};
      for (var i = 0; i < inputs.length; i++) {
        var v = inputs[i].value.trim();
        if (v) filters[inputs[i].getAttribute('data-col')] = v;
      }
      S.filters = filters;
      S.page = 1;
      update();
    }, DEBOUNCE_MS);
  }

  function onHeadChange(ev) {
    var sel = closest(ev.target, '.rt-status-filter');
    if (!sel) return;
    S.statusFilter = sel.value;
    S.page = 1;
    update();
    if (typeof S.onStatusFilterChange === 'function') {
      S.onStatusFilterChange(S.statusFilter);
    }
  }

  function onBodyClick(ev) {
    var tr = closest(ev.target, 'tr.rt-row');
    if (!tr || !S.els.tbody.contains(tr)) return;
    var cell = closest(ev.target, '.rt-cell');
    if (cell) {
      /* 已展开 → 收起；被截断 → 展开（这两种点击不触发行回调） */
      if (cell.classList.contains('rt-cell-expanded')) {
        cell.classList.remove('rt-cell-expanded');
        return;
      }
      if (cell.scrollWidth > cell.clientWidth + 1) {
        cell.classList.add('rt-cell-expanded');
        return;
      }
    }
    var idx = parseInt(tr.getAttribute('data-i'), 10);
    var entry = S.pageRows[idx];
    if (entry && S.onRowClick) S.onRowClick(entry);
  }

  function onPagerClick(ev) {
    var btn = closest(ev.target, 'button');
    if (!btn || !S.els.pager.contains(btn) || btn.disabled) return;
    if (closest(btn, '.rt-jump-go')) { doJump(); return; }
    var act = btn.getAttribute('data-act');
    if (!act) return;
    var totalPages = Math.max(1, Math.ceil(S.view.length / S.pageSize));
    if (act === 'first') S.page = 1;
    else if (act === 'prev') S.page = Math.max(1, S.page - 1);
    else if (act === 'next') S.page = Math.min(totalPages, S.page + 1);
    else if (act === 'last') S.page = totalPages;
    else return;
    renderPage(++S.token); /* 翻页无需重算 view，直接重渲染 */
  }

  function doJump() {
    var totalPages = Math.max(1, Math.ceil(S.view.length / S.pageSize));
    var n = parseInt(S.els.jumpInput.value, 10);
    if (isNaN(n)) return;
    var target = Math.min(totalPages, Math.max(1, n));
    if (target === S.page) { S.els.jumpInput.value = ''; return; }
    S.page = target;
    S.els.jumpInput.value = '';
    renderPage(++S.token);
  }

  /* ---------------- 导出 ---------------- */

  g.ResultTable = {
    init: init,
    setData: setData,
    /* 以下为 SPEC 契约外的辅助接口，供集成阶段（导出当前视图等）选用 */
    getView: function () { return S.view.slice(); },        /* 当前过滤+排序后的全量 entries */
    refresh: function () { update(); },
    /* 程序化设置/读取状态过滤（'' | match | nomatch | unknown | none），供外部选项卡/统计卡片联动 */
    setStatusFilter: function (v) {
      v = (v === 'match' || v === 'nomatch' || v === 'unknown' || v === 'none') ? v : '';
      if (S.statusFilter === v) return;
      S.statusFilter = v;
      S.page = 1;
      var sel = S.els.thead && S.els.thead.querySelector('.rt-status-filter');
      if (sel) sel.value = v;
      update();
    },
    getStatusFilter: function () { return S.statusFilter; },
    getState: function () {
      return {
        total: S.entries.length,
        filtered: S.view.length,
        page: S.page,
        pageSize: S.pageSize,
        sorts: S.sorts.slice(),
        columns: S.columns.slice()
      };
    },
    PAGE_SIZES: PAGE_SIZES
  };
})(typeof window !== 'undefined' ? window : globalThis);
