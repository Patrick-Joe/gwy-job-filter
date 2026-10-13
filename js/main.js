/* js/main.js — 集成层（window.App，DOMContentLoaded 后启动）
 * 串联：ExcelModule 导入 → 字段映射 → Matcher/RawFilter 双模式筛选 →
 * ResultTable 渲染 → 统计 / 条件标签 / 方案预设 / 导出 / 详情抽屉。
 * 契约见 SPEC.md「index.html 元素 ID 契约」。
 */
(function (g) {
  'use strict';

  /* 行对象上记录来源 sheet 的属性名（以不可枚举方式挂上，不进任何键枚举，
     因此不会污染结果表格列 / 原始列展示 / RawFilter 的任意列匹配） */
  var SHEET_PROP = '_sheetName';

  var OVERLAY_THRESHOLD = 3000; /* 智能匹配超过此行数才显示进度遮罩 */
  var INPUT_DEBOUNCE_MS = 300;

  var S = {
    fileName: '',
    sheets: [],        /* [{name, headers, rows}] */
    jobs: [],          /* 全部 sheet 合并后的行（每行带不可枚举 _sheetName） */
    headersUnion: [],  /* 全部 sheet 表头并集（映射下拉 / 导出列用） */
    mapping: { major: null, education: null, degree: null, political: null, expYears: null, project: null },
    mode: 'smart',     /* 'smart' | 'raw' */
    ready: false,      /* 已成功导入数据 */
    recalcTimer: null,
    matchToken: 0      /* 代际计数：过期的异步匹配结果直接丢弃 */
  };

  var els = {};
  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  function cfg() { return g.APP_CONFIG || {}; }

  var FIELD_IDS = ['major', 'education', 'degree', 'political', 'expYears', 'project'];

  var STATUS_LABEL = {
    match: '✅ 符合',
    nomatch: '❌ 不符合',
    unknown: '⚠️ 需核实'
  };
  var STATUS_ICON = { match: '✅', nomatch: '❌', unknown: '⚠️' };

  /* ---------------- 加载遮罩 ---------------- */
  function showLoading(text) {
    els.loadingText.textContent = text || '加载中…';
    els.loadingOverlay.hidden = false;
  }
  function hideLoading() { els.loadingOverlay.hidden = true; }

  /* ---------------- 数据导入 ---------------- */
  function importFile(file) {
    if (!file) return Promise.resolve({ ok: false, error: 'no file' });
    showLoading('正在解析文件：' + (file.name || ''));
    return g.ExcelModule.parseFile(file).then(function (res) {
      res = res || { sheets: [], errors: [] };
      var errors = res.errors || [];
      if (errors.length) console.warn('[导入提示]', errors);

      var total = 0;
      (res.sheets || []).forEach(function (sh) { total += sh.rows.length; });

      if (!res.sheets || !res.sheets.length || total === 0) {
        hideLoading();
        var msg0 = '未能从文件中解析出岗位数据。';
        if (errors.length) msg0 += '\n' + errors.map(errText).join('\n');
        else msg0 += '\n文件为空或所有工作表都没有数据行。';
        alert(msg0);
        return { ok: false, errors: errors };
      }
      if (errors.length) {
        alert('文件解析完成，但有以下提示：\n' + errors.map(errText).join('\n'));
      }

      S.fileName = file.name || '未命名文件';
      S.sheets = res.sheets;
      S.jobs = [];
      S.headersUnion = [];
      var seen = {};
      res.sheets.forEach(function (sh) {
        sh.headers.forEach(function (h) {
          if (!seen[h]) { seen[h] = 1; S.headersUnion.push(h); }
        });
        sh.rows.forEach(function (row) {
          try {
            Object.defineProperty(row, SHEET_PROP, {
              value: sh.name, enumerable: false, writable: true, configurable: true
            });
          } catch (e) { row[SHEET_PROP] = sh.name; }
          S.jobs.push(row);
        });
      });
      S.mapping = g.ExcelModule.detectMapping(res.sheets[0].headers);
      S.ready = true;
      S.matchToken++;

      els.fileInfo.textContent = S.fileName + ' · 岗位总数 ' + fmt(S.jobs.length);
      els.btnMapping.disabled = false;
      els.btnReupload.disabled = false;
      els.sheetSelect.disabled = false;
      els.btnExport.disabled = false;
      els.importSection.classList.add('has-file');
      fillSheetSelect();
      fillMappingSelects();
      hideLoading();

      var missing = FIELD_IDS.filter(function (k) { return !S.mapping[k]; });
      if (missing.length) {
        console.warn('[字段映射] 以下字段未能自动识别，请手动映射：', missing.join(', '));
        openMappingModal();
      }
      return recalc().then(function () {
        return { ok: true, total: total, mapping: S.mapping, errors: errors };
      });
    }).catch(function (e) {
      hideLoading();
      alert('文件解析出错：' + (e && e.message ? e.message : String(e)));
      return { ok: false, error: String(e) };
    });
  }

  function errText(e) { return (e.sheet ? '[' + e.sheet + '] ' : '') + e.message; }

  function fillSheetSelect() {
    var sel = els.sheetSelect;
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = '全部（' + fmt(S.jobs.length) + ' 行）';
    sel.appendChild(all);
    S.sheets.forEach(function (sh) {
      var o = document.createElement('option');
      o.value = sh.name;
      o.textContent = sh.name + '（' + fmt(sh.rows.length) + ' 行）';
      sel.appendChild(o);
    });
    sel.value = '';
  }

  /* 当前 sheet 筛选范围内的岗位行 */
  function scopeJobs() {
    var v = els.sheetSelect.value;
    if (!v) return S.jobs;
    return S.jobs.filter(function (j) { return j[SHEET_PROP] === v; });
  }

  /* ---------------- 字段映射模态框 ---------------- */
  function fillMappingSelects() {
    (cfg().CORE_FIELDS || []).forEach(function (f) {
      var sel = $('map-' + f.key);
      if (!sel) return;
      sel.innerHTML = '';
      var none = document.createElement('option');
      none.value = '';
      none.textContent = '（不映射）';
      sel.appendChild(none);
      S.headersUnion.forEach(function (h) {
        var o = document.createElement('option');
        o.value = h;
        o.textContent = h;
        sel.appendChild(o);
      });
      sel.value = S.mapping[f.key] || '';
    });
  }

  function openMappingModal() {
    fillMappingSelects();
    els.mappingModal.hidden = false;
  }
  function closeMappingModal() { els.mappingModal.hidden = true; }

  function saveMapping() {
    (cfg().CORE_FIELDS || []).forEach(function (f) {
      var sel = $('map-' + f.key);
      S.mapping[f.key] = sel && sel.value ? sel.value : null;
    });
    closeMappingModal();
    recalc();
  }

  /* ---------------- 条件收集 ---------------- */
  function collectUserCond() {
    var kws = els.inputMajor.value.split(/[,，、;；\s]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    var projects = [];
    var noneChecked = false;
    var boxes = els.projectChecks.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) {
      /* UI 的 none checkbox 翻译成空数组，绝不把 'none' 传给 Matcher */
      if (boxes[i].checked) {
        if (boxes[i].value === 'none') noneChecked = true;
        else projects.push(boxes[i].value);
      }
    }
    /* 什么都不勾选 = 不限（null，跳过该条件）；勾选"无相关经历" = []；勾选具体项目 = 项目列表 */
    var projectsCond = projects.length ? projects : (noneChecked ? [] : null);
    return {
      majorKeywords: kws,
      majorMode: els.majorMode.value === 'exact' ? 'exact' : 'fuzzy',
      education: parseInt(els.selEducation.value, 10) || 0,
      degree: parseInt(els.selDegree.value, 10) || 0,
      political: els.selPolitical.value,
      expYears: els.selExpYears.value === '' ? -1 : parseInt(els.selExpYears.value, 10),
      projects: projectsCond
    };
  }

  function collectRawConds() {
    var conds = {};
    FIELD_IDS.forEach(function (k) {
      var v = $('raw-' + k).value.trim();
      if (v) conds[k] = v;
    });
    var kw = els.rawKeyword.value.trim();
    if (kw) conds[g.RawFilter.ANY_COLUMN || '*'] = kw;
    return conds;
  }

  /* ---------------- 重算（智能 / 原始） ---------------- */
  function recalc() {
    renderTags();
    if (!S.ready) return Promise.resolve(false);
    var jobs = scopeJobs();
    if (S.mode === 'smart') return recalcSmart(jobs);
    return recalcRaw(jobs);
  }

  function recalcSmart(jobs) {
    var cond = collectUserCond();
    var token = ++S.matchToken;
    var useOverlay = jobs.length > OVERLAY_THRESHOLD;
    if (useOverlay) showLoading('正在匹配 0 / ' + fmt(jobs.length) + ' …');
    return g.Matcher.matchJobsChunked(jobs, cond, S.mapping, function (done, total) {
      if (useOverlay && token === S.matchToken) {
        els.loadingText.textContent = '正在匹配 ' + fmt(done) + ' / ' + fmt(total) + ' …';
      }
    }).then(function (results) {
      if (token !== S.matchToken) return false; /* 已被更新的条件取代 */
      hideLoading();
      var entries = new Array(jobs.length);
      for (var i = 0; i < jobs.length; i++) {
        entries[i] = { job: jobs[i], result: results[i], rawText: jobs[i][SHEET_PROP] };
      }
      g.ResultTable.setData(entries);
      var nMatch = 0, nUnknown = 0, nNomatch = 0;
      for (i = 0; i < results.length; i++) {
        var ov = results[i] && results[i].overall;
        if (ov === 'match') nMatch++;
        else if (ov === 'nomatch') nNomatch++;
        else nUnknown++;
      }
      els.statTotal.textContent = fmt(jobs.length);
      els.statMatch.textContent = fmt(nMatch);
      els.statUnknown.textContent = fmt(nUnknown);
      els.statNomatch.textContent = fmt(nNomatch);
      return true;
    });
  }

  function recalcRaw(jobs) {
    var conds = collectRawConds();
    var hits = g.RawFilter.matchJobs(jobs, conds);
    var entries = new Array(hits.length);
    for (var i = 0; i < hits.length; i++) {
      entries[i] = { job: hits[i], result: null, rawText: hits[i][SHEET_PROP] };
    }
    g.ResultTable.setData(entries);
    els.statTotal.textContent = fmt(jobs.length);
    els.statMatch.textContent = fmt(hits.length);
    els.statUnknown.textContent = '—';
    els.statNomatch.textContent = '—';
    return Promise.resolve(true);
  }

  function scheduleRecalc() {
    clearTimeout(S.recalcTimer);
    S.recalcTimer = setTimeout(recalc, INPUT_DEBOUNCE_MS);
  }

  /* ---------------- 模式切换 ---------------- */
  function switchMode(mode) {
    if (mode !== 'smart' && mode !== 'raw') return;
    S.mode = mode;
    els.tabSmart.classList.toggle('active', mode === 'smart');
    els.tabRaw.classList.toggle('active', mode === 'raw');
    els.tabSmart.setAttribute('aria-selected', mode === 'smart' ? 'true' : 'false');
    els.tabRaw.setAttribute('aria-selected', mode === 'raw' ? 'true' : 'false');
    els.panelSmart.hidden = mode !== 'smart';
    els.panelRaw.hidden = mode !== 'raw';
    recalc();
  }

  /* ---------------- 清空条件 ---------------- */
  function clearConds() {
    els.inputMajor.value = '';
    els.majorMode.value = 'fuzzy';
    els.selEducation.value = '0';
    els.selDegree.value = '0';
    els.selPolitical.value = '';
    els.selExpYears.value = '-1';
    var boxes = els.projectChecks.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    FIELD_IDS.forEach(function (k) { $('raw-' + k).value = ''; });
    els.rawKeyword.value = '';
    recalc();
  }

  /* ---------------- 当前条件标签 ---------------- */
  function tagEl(label, clearKey) {
    var tag = document.createElement('span');
    tag.className = 'tag';
    var txt = document.createElement('span');
    txt.textContent = label;
    tag.appendChild(txt);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'tag-x';
    x.title = '移除此条件';
    x.setAttribute('data-clear', clearKey);
    x.textContent = '×';
    tag.appendChild(x);
    return tag;
  }

  function selText(sel) {
    return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : sel.value;
  }

  function renderTags() {
    var box = els.filterTags;
    box.innerHTML = '';
    if (S.mode === 'smart') {
      var cond = collectUserCond();
      if (cond.majorKeywords.length) {
        box.appendChild(tagEl(
          '专业：' + cond.majorKeywords.join('、') + (cond.majorMode === 'exact' ? '（精确）' : '（模糊）'),
          'major'));
      }
      if (cond.education) box.appendChild(tagEl('学历：' + selText(els.selEducation), 'education'));
      if (cond.degree) box.appendChild(tagEl('学位：' + selText(els.selDegree), 'degree'));
      if (cond.political) box.appendChild(tagEl('政治面貌：' + selText(els.selPolitical), 'political'));
      if (cond.expYears > -1 && !isNaN(cond.expYears)) {
        box.appendChild(tagEl('基层年限：' + selText(els.selExpYears), 'expYears'));
      }
      if (cond.projects && cond.projects.length) {
        var names = cond.projects.map(projectLabel);
        box.appendChild(tagEl('服务项目：' + names.join('、'), 'projects'));
      } else if (cond.projects && isNoneChecked()) {
        box.appendChild(tagEl('服务项目：无相关经历', 'projects'));
      }
    } else {
      var conds = collectRawConds();
      var labels = { major: '专业列', education: '学历列', degree: '学位列', political: '政治面貌列', expYears: '基层年限列', project: '服务项目列' };
      Object.keys(conds).forEach(function (k) {
        var label = (k === (g.RawFilter.ANY_COLUMN || '*')) ? '任意列' : (labels[k] || k);
        box.appendChild(tagEl(label + '：' + conds[k], 'raw-' + k));
      });
    }
    if (!box.children.length) {
      var hint = document.createElement('span');
      hint.className = 'tag tag-hit';
      hint.textContent = '未设置任何条件（显示全部岗位）';
      box.appendChild(hint);
    }
  }

  function projectLabel(key) {
    var types = cfg().PROJECT_TYPES || [];
    for (var i = 0; i < types.length; i++) if (types[i].key === key) return types[i].label;
    return key;
  }

  function isNoneChecked() {
    var b = els.projectChecks.querySelector('input[value="none"]');
    return !!(b && b.checked);
  }

  function clearByKey(key) {
    switch (key) {
      case 'major': els.inputMajor.value = ''; break;
      case 'education': els.selEducation.value = '0'; break;
      case 'degree': els.selDegree.value = '0'; break;
      case 'political': els.selPolitical.value = ''; break;
      case 'expYears': els.selExpYears.value = '-1'; break;
      case 'projects':
        var boxes = els.projectChecks.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
        break;
      case 'raw-*': els.rawKeyword.value = ''; break;
      default:
        if (key.indexOf('raw-') === 0 && $(key)) $(key).value = '';
    }
    recalc();
  }

  /* ---------------- 方案预设（localStorage） ---------------- */
  function loadPresets() {
    try {
      var raw = localStorage.getItem(cfg().STORAGE_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }

  function persistPresets(p) {
    try { localStorage.setItem(cfg().STORAGE_KEY, JSON.stringify(p)); } catch (e) { /* 隐私模式等场景静默失败 */ }
  }

  function refreshPresetSelect(selectName) {
    var sel = els.selPreset;
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '载入方案…';
    sel.appendChild(ph);
    Object.keys(loadPresets()).sort().forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
    sel.value = selectName || '';
  }

  /* 组装当前控件状态为方案对象（userCond 存原始控件值，便于恢复 UI） */
  function buildPreset() {
    var boxes = els.projectChecks.querySelectorAll('input[type="checkbox"]');
    var projects = [], none = false;
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) continue;
      if (boxes[i].value === 'none') none = true; else projects.push(boxes[i].value);
    }
    var rawConds = {};
    FIELD_IDS.forEach(function (k) { rawConds[k] = $('raw-' + k).value; });
    rawConds.keyword = els.rawKeyword.value;
    return {
      mode: S.mode,
      userCond: {
        majorText: els.inputMajor.value,
        majorMode: els.majorMode.value,
        education: els.selEducation.value,
        degree: els.selDegree.value,
        political: els.selPolitical.value,
        expYears: els.selExpYears.value,
        projects: projects,
        none: none
      },
      rawConds: rawConds
    };
  }

  function savePreset(name) {
    if (!name) return false;
    var all = loadPresets();
    all[name] = buildPreset();
    persistPresets(all);
    refreshPresetSelect(name);
    return true;
  }

  function applyPreset(name) {
    var p = loadPresets()[name];
    if (!p) return false;
    var uc = p.userCond || {};
    els.inputMajor.value = uc.majorText || '';
    els.majorMode.value = uc.majorMode === 'exact' ? 'exact' : 'fuzzy';
    els.selEducation.value = uc.education !== undefined ? String(uc.education) : '0';
    els.selDegree.value = uc.degree !== undefined ? String(uc.degree) : '0';
    els.selPolitical.value = uc.political || '';
    els.selExpYears.value = uc.expYears !== undefined ? String(uc.expYears) : '-1';
    var boxes = els.projectChecks.querySelectorAll('input[type="checkbox"]');
    var has = {};
    (uc.projects || []).forEach(function (k) { has[k] = true; });
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = boxes[i].value === 'none' ? !!uc.none : !!has[boxes[i].value];
    }
    var rc = p.rawConds || {};
    FIELD_IDS.forEach(function (k) { $('raw-' + k).value = rc[k] || ''; });
    els.rawKeyword.value = rc.keyword || '';
    switchMode(p.mode === 'raw' ? 'raw' : 'smart'); /* 内部会 recalc */
    return true;
  }

  /* ---------------- 导出 ---------------- */
  function exportStatusLabel(result) {
    if (!result) return '— 未匹配';
    return STATUS_LABEL[result.overall] || '— 未匹配';
  }

  function exportStatusDesc(result) {
    if (!result || !result.fields) return '';
    var parts = [];
    (cfg().CORE_FIELDS || []).forEach(function (f) {
      var r = result.fields[f.key];
      if (r && r.status && r.status !== 'match') {
        parts.push(f.label + '：' + (r.reason || r.status));
      }
    });
    return parts.length ? parts.join('；') : '全部核心条件符合';
  }

  function exportView() {
    if (!S.ready) return;
    var view = g.ResultTable.getView();
    if (!view.length) { alert('当前没有可导出的记录'); return; }
    var cols = ['匹配状态', '匹配说明'].concat(S.headersUnion).concat(['来源工作表']);
    var rows = view.map(function (en) {
      var o = {
        '匹配状态': exportStatusLabel(en.result),
        '匹配说明': exportStatusDesc(en.result)
      };
      S.headersUnion.forEach(function (h) {
        var v = en.job ? en.job[h] : '';
        o[h] = (v === null || v === undefined) ? '' : v;
      });
      o['来源工作表'] = en.job ? (en.job[SHEET_PROP] || '') : '';
      return o;
    });
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var fname = '岗位筛选结果_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.xlsx';
    g.Exporter.exportXlsx(rows, cols, fname);
  }

  /* ---------------- 详情抽屉 ---------------- */
  var drawerMask = null;

  function ensureMask() {
    if (drawerMask) return drawerMask;
    drawerMask = document.createElement('div');
    drawerMask.className = 'drawer-mask';
    drawerMask.addEventListener('click', closeDrawer);
    document.body.appendChild(drawerMask);
    return drawerMask;
  }

  function openDrawer(entry) {
    renderDetail(entry);
    els.detailDrawer.classList.add('open');
    els.detailDrawer.setAttribute('aria-hidden', 'false');
    ensureMask().hidden = false;
  }

  function closeDrawer() {
    els.detailDrawer.classList.remove('open');
    els.detailDrawer.setAttribute('aria-hidden', 'true');
    if (drawerMask) drawerMask.hidden = true;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderDetail(entry) {
    var body = els.detailBody;
    body.innerHTML = '';
    var job = entry && entry.job ? entry.job : {};
    var result = entry && entry.result;

    body.appendChild(el('h3', null, '资格匹配结论'));
    if (result) {
      body.appendChild(el('div', 'detail-overall st-' + (result.overall || 'unknown'),
        (STATUS_LABEL[result.overall] || result.overall)));
      (cfg().CORE_FIELDS || []).forEach(function (f) {
        var r = result.fields && result.fields[f.key];
        if (!r) return;
        var row = el('div', 'kv-row');
        row.appendChild(el('span', 'kv-key', (STATUS_ICON[r.status] || '') + ' ' + f.label));
        var val = el('span', 'kv-val');
        val.appendChild(el('span', 'reason ' + r.status, r.reason || r.status));
        row.appendChild(val);
        body.appendChild(row);
      });
    } else {
      body.appendChild(el('p', null, '原始条件筛选模式：未进行资格匹配，状态列显示 —。'));
    }

    body.appendChild(el('h3', null, '岗位原始字段'));
    var row0 = el('div', 'kv-row');
    row0.appendChild(el('span', 'kv-key', '来源工作表'));
    row0.appendChild(el('span', 'kv-val', job[SHEET_PROP] || ''));
    body.appendChild(row0);
    Object.keys(job).forEach(function (k) {
      if (k.charAt(0) === '_') return; /* 内部属性不展示 */
      var row = el('div', 'kv-row');
      row.appendChild(el('span', 'kv-key', k));
      row.appendChild(el('span', 'kv-val', job[k]));
      body.appendChild(row);
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    /* 导入 */
    els.btnPickFile.addEventListener('click', function () { els.fileInput.click(); });
    els.btnReupload.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = ''; /* 允许重复选同一文件 */
      if (f) importFile(f);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      els.dropZone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropZone.classList.add('drag-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      els.dropZone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropZone.classList.remove('drag-over');
      });
    });
    els.dropZone.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      els.dropZone.classList.remove('drag-over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });

    /* 字段映射 */
    els.btnMapping.addEventListener('click', openMappingModal);
    els.btnMappingClose.addEventListener('click', closeMappingModal);
    els.btnMappingSave.addEventListener('click', saveMapping);
    els.mappingModal.addEventListener('click', function (e) {
      if (e.target === els.mappingModal) closeMappingModal(); /* 点遮罩关闭 */
    });

    /* 模式切换 */
    els.tabSmart.addEventListener('click', function () { switchMode('smart'); });
    els.tabRaw.addEventListener('click', function () { switchMode('raw'); });

    /* 筛选控件：文本输入 300ms 防抖，其余 change 立即重算 */
    [els.panelSmart, els.panelRaw].forEach(function (panel) {
      panel.addEventListener('input', function (e) {
        if (e.target && e.target.matches('input[type="text"]')) scheduleRecalc();
      });
      panel.addEventListener('change', function () { recalc(); });
    });

    /* 服务基层项目：「无相关经历」与具体项目互斥 */
    els.projectChecks.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox') return;
      var boxes = els.projectChecks.querySelectorAll('input[type="checkbox"]');
      if (cb.value === 'none' && cb.checked) {
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i].value !== 'none') boxes[i].checked = false;
        }
      } else if (cb.value !== 'none' && cb.checked) {
        var none = els.projectChecks.querySelector('input[value="none"]');
        if (none) none.checked = false;
      }
    });

    /* sheet 筛选 */
    els.sheetSelect.addEventListener('change', function () { recalc(); });

    /* 条件标签 × 移除（事件委托） */
    els.filterTags.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.tag-x') : null;
      if (!btn || !els.filterTags.contains(btn)) return;
      clearByKey(btn.getAttribute('data-clear'));
    });

    /* 清空 / 预设 */
    els.btnClear.addEventListener('click', clearConds);
    els.btnSavePreset.addEventListener('click', function () {
      var name = prompt('请输入方案名称：');
      if (name === null) return;
      name = name.trim();
      if (!name) { alert('方案名称不能为空'); return; }
      if (loadPresets()[name] && !confirm('已存在同名方案「' + name + '」，覆盖？')) return;
      savePreset(name);
    });
    els.selPreset.addEventListener('change', function () {
      var name = els.selPreset.value;
      if (name) applyPreset(name);
    });

    /* 导出 */
    els.btnExport.addEventListener('click', exportView);

    /* 详情抽屉 */
    els.btnDrawerClose.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.keyCode === 27) && els.detailDrawer.classList.contains('open')) {
        closeDrawer();
      }
    });
  }

  /* ---------------- 默认数据自动加载 ---------------- */
  /* http(s) 环境（如 GitHub Pages）下自动载入内置岗位数据；
     file:// 双击打开时浏览器禁止 fetch 本地文件，静默回退为手动导入 */
  var DEFAULT_DATA_URL = 'data/2027年度国考岗位.csv';
  function tryLoadDefaultData() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    showLoading('正在载入内置岗位数据…');
    fetch(DEFAULT_DATA_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        hideLoading();
        var file = new File([blob], '2027年度国考岗位.csv', { type: 'text/csv' });
        return importFile(file);
      })
      .catch(function () {
        hideLoading(); /* 内置数据不可用时保持手动导入模式 */
      });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    [
      'importSection', 'fileInput', 'dropZone', 'btnPickFile', 'fileInfo', 'btnReupload', 'btnMapping',
      'mappingModal', 'btnMappingSave', 'btnMappingClose', 'sheetSelect',
      'tabSmart', 'tabRaw', 'panelSmart', 'panelRaw',
      'inputMajor', 'majorMode', 'selEducation', 'selDegree', 'selPolitical', 'selExpYears', 'projectChecks',
      'rawKeyword', 'btnClear', 'btnSavePreset', 'selPreset', 'filterTags',
      'statTotal', 'statMatch', 'statUnknown', 'statNomatch',
      'tableContainer', 'btnExport', 'loadingOverlay', 'loadingText',
      'detailDrawer', 'detailBody', 'btnDrawerClose'
    ].forEach(function (id) { els[id] = $(id); });

    g.ResultTable.init(els.tableContainer, { onRowClick: openDrawer });
    bindEvents();
    refreshPresetSelect();
    renderTags();
    tryLoadDefaultData();

    g.App = {
      importFile: importFile,
      recalc: recalc,
      switchMode: switchMode,
      clearConds: clearConds,
      savePreset: savePreset,
      applyPreset: applyPreset,
      openDrawer: openDrawer,
      closeDrawer: closeDrawer,
      scopeJobs: scopeJobs,
      collectUserCond: collectUserCond,
      collectRawConds: collectRawConds,
      state: function () { return S; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
