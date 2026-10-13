/* Excel/CSV 文件解析 + 字段映射自动探测（Agent B）
 * 浏览器：全局 window.ExcelModule，依赖先行加载的 window.XLSX（libs/xlsx.full.min.js）
 * node：  globalThis.ExcelModule，XLSX 通过 require 本地库获得
 *
 * 接口（与 SPEC.md 契约一致）：
 *   parseFile(file)      → Promise<{sheets:[{name, headers:[], rows:[{}]}], errors:[]}>
 *   detectMapping(headers) → {major, education, degree, political, expYears, project}
 */
(function (g) {
  'use strict';

  /* 同时兼容浏览器（window.XLSX 全局）与 node（require 本地 UMD 库） */
  var XLSXRef = g.XLSX;
  if (!XLSXRef && typeof require !== 'undefined' && typeof window === 'undefined') {
    try { XLSXRef = require('../libs/xlsx.full.min.js'); } catch (e) { XLSXRef = null; }
  }

  var HEADER_SCAN_ROWS = 5;   /* 表头探测范围：前 5 行 */
  var MIN_ALIAS_HITS = 2;     /* 至少命中 2 个核心字段别名才认定是表头行 */

  function getConfig() {
    return g.APP_CONFIG || null;
  }

  /* 所有单元格统一转字符串（防止 030101K / 002000 变数字丢前导零） */
  function toStr(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  /* 表头清洗：去 BOM、去首尾空白；数据单元格不改动 */
  function cleanHeader(v) {
    return toStr(v).replace(/^\uFEFF/, '').trim();
  }

  /* 统计某一行命中了多少个核心字段（单元格精确等于某别名，去空白后比较） */
  function countCoreFieldHits(rowArr, coreFields) {
    var cells = {};
    for (var i = 0; i < rowArr.length; i++) {
      var t = cleanHeader(rowArr[i]);
      if (t) cells[t] = true;
    }
    var hits = 0;
    for (var f = 0; f < coreFields.length; f++) {
      var aliases = coreFields[f].aliases || [];
      for (var a = 0; a < aliases.length; a++) {
        if (cells[aliases[a]]) { hits++; break; }
      }
    }
    return hits;
  }

  /* 在前 5 行中探测表头行，返回行下标；找不到返回 -1 */
  function detectHeaderRowIndex(rowArrays, coreFields) {
    var limit = Math.min(HEADER_SCAN_ROWS, rowArrays.length);
    for (var i = 0; i < limit; i++) {
      if (countCoreFieldHits(rowArrays[i], coreFields) >= MIN_ALIAS_HITS) return i;
    }
    return -1;
  }

  /* 由表头行构造最终列名：空表头补占位名，重名加序号，避免静默丢列 */
  function buildHeaders(headerRowArr, dataRowArrays) {
    var headers = [];
    var used = {};
    for (var i = 0; i < headerRowArr.length; i++) {
      var name = cleanHeader(headerRowArr[i]);
      if (!name) {
        /* 空表头：整列无数据则丢弃该列（用 null 占位），有数据则给占位名 */
        var hasData = false;
        for (var r = 0; r < dataRowArrays.length; r++) {
          if (toStr(dataRowArrays[r][i]) !== '') { hasData = true; break; }
        }
        if (!hasData) { headers.push(null); continue; }
        name = '（未命名列' + (i + 1) + '）';
      }
      if (used[name]) {
        var n = used[name] + 1;
        used[name] = n;
        name = name + '_' + n;
      } else {
        used[name] = 1;
      }
      headers.push(name);
    }
    return headers;
  }

  function rowArrayToObject(rowArr, headers) {
    var obj = {};
    var allEmpty = true;
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] === null) continue;
      var v = toStr(rowArr[i]);
      if (v !== '') allEmpty = false;
      obj[headers[i]] = v;
    }
    return allEmpty ? null : obj; /* 整行空白 → 丢弃 */
  }

  /* 输入归一化为 {bytes:Uint8Array, name:string} */
  function readInput(input, opts) {
    opts = opts || {};
    var name = opts.filename || '';
    if (typeof input === 'string') {
      /* node 专用：直接传文件路径 */
      if (typeof window !== 'undefined' || typeof require === 'undefined') {
        return Promise.reject(new Error('浏览器环境不支持路径字符串，请传 File 对象'));
      }
      var fs = require('fs');
      var path = require('path');
      var buf = fs.readFileSync(input); /* 失败直接抛错，由 parseFile 捕获进 errors */
      return Promise.resolve({
        bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        name: name || path.basename(input)
      });
    }
    /* 鸭子类型判定，跨 realm（如 iframe/vm）传入也能识别 */
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      /* Uint8Array / Buffer 等 TypedArray */
      return Promise.resolve({ bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength), name: name });
    }
    if (input && typeof input.byteLength === 'number' && typeof input.slice === 'function' && !input.arrayBuffer) {
      /* ArrayBuffer（含跨 realm） */
      return Promise.resolve({ bytes: new Uint8Array(input), name: name });
    }
    if (input && typeof input.arrayBuffer === 'function') {
      /* 浏览器 File / Blob */
      name = name || input.name || '';
      return input.arrayBuffer().then(function (ab) {
        return { bytes: new Uint8Array(ab), name: name };
      });
    }
    return Promise.reject(new Error('无法识别的输入类型：期望 File/Blob/ArrayBuffer/Uint8Array' +
      (typeof window === 'undefined' ? '/文件路径字符串' : '')));
  }

  /*
   * parseFile(file) → Promise<{sheets:[{name, headers:[], rows:[{}]}], errors:[]}>
   * - 支持 .xlsx/.xls/.csv（XLSX.read 按内容自动识别，csv 文本直接可读）
   * - 每个 sheet 自动探测表头行（前 5 行含 ≥2 个核心字段别名），其上的说明行跳过
   * - 空 sheet 跳过；所有单元格值转字符串；行对象键 = 表头原文
   * - 解析不致命的问题写入 errors，不 reject
   */
  function parseFile(input, opts) {
    var errors = [];
    if (!XLSXRef) {
      return Promise.resolve({ sheets: [], errors: [{ message: 'XLSX 库未加载（libs/xlsx.full.min.js）' }] });
    }
    var cfg = getConfig();
    if (!cfg || !cfg.CORE_FIELDS) {
      return Promise.resolve({ sheets: [], errors: [{ message: 'APP_CONFIG 未加载（js/config.js 需先于 excel.js）' }] });
    }
    var fileName = '';
    return Promise.resolve().then(function () {
      return readInput(input, opts); /* 同步异常（如文件不存在）转为 rejection，由下方 catch 统一进 errors */
    }).then(function (norm) {
      fileName = norm.name || '未命名文件';
      var wb;
      try {
        wb = XLSXRef.read(norm.bytes, { type: 'array', raw: true, cellText: true });
      } catch (e) {
        errors.push({ message: '文件读取失败：' + (e && e.message ? e.message : String(e)) });
        return { sheets: [], errors: errors };
      }
      var isCsv = /\.csv$/i.test(fileName);
      var sheets = [];
      for (var s = 0; s < wb.SheetNames.length; s++) {
        var sheetName = wb.SheetNames[s];
        var ws = wb.Sheets[sheetName];
        var rowArrays;
        try {
          /* raw:false → 使用格式化文本（.w），保证全部是字符串且保留前导零 */
          rowArrays = XLSXRef.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
        } catch (e) {
          errors.push({ sheet: sheetName, message: 'sheet 解析失败：' + (e && e.message ? e.message : String(e)) });
          continue;
        }
        if (!rowArrays || rowArrays.length === 0) continue; /* 空 sheet 跳过 */
        var headerIdx = detectHeaderRowIndex(rowArrays, cfg.CORE_FIELDS);
        if (headerIdx < 0) {
          errors.push({ sheet: sheetName, message: '前 ' + HEADER_SCAN_ROWS + ' 行未检测到表头（需含 ≥' + MIN_ALIAS_HITS + ' 个核心字段别名），已跳过' });
          continue;
        }
        var dataRowArrays = rowArrays.slice(headerIdx + 1);
        var headers = buildHeaders(rowArrays[headerIdx], dataRowArrays);
        var rows = [];
        for (var r = 0; r < dataRowArrays.length; r++) {
          var obj = rowArrayToObject(dataRowArrays[r], headers);
          if (obj) rows.push(obj);
        }
        /* CSV 单 sheet 时用文件名命名，比 'Sheet1' 更有意义 */
        var finalName = sheetName;
        if (isCsv && wb.SheetNames.length === 1) {
          finalName = fileName.replace(/\.[^.]+$/, '') || sheetName;
        }
        sheets.push({ name: finalName, headers: headers.filter(function (h) { return h !== null; }), rows: rows });
      }
      if (sheets.length === 0 && errors.length === 0) {
        errors.push({ message: '文件中没有可用数据（全部 sheet 为空）' });
      }
      return { sheets: sheets, errors: errors };
    }).catch(function (e) {
      errors.push({ message: (e && e.message) ? e.message : String(e) });
      return { sheets: [], errors: errors };
    });
  }

  /*
   * detectMapping(headers) → {major, education, degree, political, expYears, project}
   * 按 APP_CONFIG.CORE_FIELDS[].aliases：① 精确匹配 → ② 表头包含别名 → ③ 别名包含表头（表头长≥2）
   * 找不到的字段为 null；同一列不会被映射给两个字段。
   */
  function detectMapping(headers) {
    var result = { major: null, education: null, degree: null, political: null, expYears: null, project: null };
    var cfg = getConfig();
    if (!cfg || !cfg.CORE_FIELDS || !headers) return result;
    var norm = [];
    for (var i = 0; i < headers.length; i++) {
      norm.push({ orig: headers[i], t: cleanHeader(headers[i]) });
    }
    var used = {};
    var fields = cfg.CORE_FIELDS;

    /* ① 精确匹配 */
    fields.forEach(function (f) {
      for (var i = 0; i < norm.length; i++) {
        if (used[i] || !norm[i].t) continue;
        if (f.aliases.indexOf(norm[i].t) >= 0) { result[f.key] = norm[i].orig; used[i] = true; break; }
      }
    });
    /* ② 表头包含别名（如 "专业（本科段）" 含 "专业"） */
    fields.forEach(function (f) {
      if (result[f.key]) return;
      for (var i = 0; i < norm.length; i++) {
        if (used[i] || !norm[i].t) continue;
        for (var a = 0; a < f.aliases.length; a++) {
          if (norm[i].t.indexOf(f.aliases[a]) >= 0) { result[f.key] = norm[i].orig; used[i] = true; break; }
        }
        if (result[f.key]) break;
      }
    });
    /* ③ 别名包含表头（如表头简写 "学历" 命中别名 "学历要求"；表头需 ≥2 字防误配） */
    fields.forEach(function (f) {
      if (result[f.key]) return;
      for (var i = 0; i < norm.length; i++) {
        if (used[i] || norm[i].t.length < 2) continue;
        for (var a = 0; a < f.aliases.length; a++) {
          if (f.aliases[a].indexOf(norm[i].t) >= 0) { result[f.key] = norm[i].orig; used[i] = true; break; }
        }
        if (result[f.key]) break;
      }
    });
    return result;
  }

  g.ExcelModule = {
    parseFile: parseFile,
    detectMapping: detectMapping
  };
})(typeof window !== 'undefined' ? window : globalThis);
