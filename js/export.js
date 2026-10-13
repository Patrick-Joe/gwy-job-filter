/* 结果导出（Agent B）
 * 浏览器：window.Exporter，依赖 window.XLSX，writeFile 触发下载
 * node：  globalThis.Exporter，XLSX 经 require 本地库获得，写盘走 fs
 *
 * 接口（与 SPEC.md 契约一致）：
 *   exportXlsx(rows, columns, filename)
 *     rows     平面对象数组（含匹配状态/原因列）
 *     columns  列定义：['列名', ...] 或 [{key, label}, ...]；省略时取全部键（首次出现顺序）
 *     filename 导出文件名，缺省补 .xlsx 扩展名
 */
(function (g) {
  'use strict';

  /* 同时兼容浏览器（window.XLSX 全局）与 node（require 本地 UMD 库） */
  var XLSXRef = g.XLSX;
  if (!XLSXRef && typeof require !== 'undefined' && typeof window === 'undefined') {
    try { XLSXRef = require('../libs/xlsx.full.min.js'); } catch (e) { XLSXRef = null; }
  }

  var DEFAULT_SHEET_NAME = '筛选结果';

  function normalizeColumns(columns, rows) {
    if (columns && columns.length) {
      return columns.map(function (c) {
        if (typeof c === 'string') return { key: c, label: c };
        return { key: c.key, label: (c.label !== undefined && c.label !== null) ? c.label : c.key };
      });
    }
    /* 未指定列：按行对象键首次出现顺序全量导出 */
    var seen = {};
    var out = [];
    (rows || []).forEach(function (r) {
      Object.keys(r).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; out.push({ key: k, label: k }); }
      });
    });
    return out;
  }

  /* 值统一转字符串导出（002000、0301 等前导零/代码文本不写死成数字） */
  function buildSheetRows(rows, cols) {
    return (rows || []).map(function (r) {
      var o = {};
      cols.forEach(function (c) {
        var v = r ? r[c.key] : '';
        o[c.label] = (v === null || v === undefined) ? '' : String(v);
      });
      return o;
    });
  }

  function exportXlsx(rows, columns, filename) {
    if (!XLSXRef) throw new Error('XLSX 库未加载（libs/xlsx.full.min.js）');
    rows = rows || [];
    var cols = normalizeColumns(columns, rows);
    var sheetRows = buildSheetRows(rows, cols);
    var ws = XLSXRef.utils.json_to_sheet(sheetRows, { header: cols.map(function (c) { return c.label; }) });
    var wb = XLSXRef.utils.book_new();
    XLSXRef.utils.book_append_sheet(wb, ws, DEFAULT_SHEET_NAME);

    filename = filename || (DEFAULT_SHEET_NAME + '.xlsx');
    if (!/\.(xlsx|csv)$/i.test(filename)) filename += '.xlsx';

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      XLSXRef.writeFile(wb, filename); /* 浏览器：触发下载 */
    } else {
      /* node：写磁盘（writeFile 在此 UMD 构建中无 fs，改用手动 write + fs） */
      var bookType = /\.csv$/i.test(filename) ? 'csv' : 'xlsx';
      var out = XLSXRef.write(wb, { type: 'buffer', bookType: bookType });
      require('fs').writeFileSync(filename, out);
    }
    return filename;
  }

  g.Exporter = {
    exportXlsx: exportXlsx
  };
})(typeof window !== 'undefined' ? window : globalThis);
