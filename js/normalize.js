/* js/normalize.js — 单元格文本 → 结构化规则（window.Normalize）
 * 契约见 SPEC.md「模块接口契约」。解析不了返回 null，绝不猜；
 * 空白/空串返回 {empty:true}（由 Matcher 判 ⚠️，不是无限制）。
 * 环境无关：浏览器挂 window，node 挂 globalThis。
 */
(function (g) {
  'use strict';

  function cfg() { return g.APP_CONFIG || {}; }

  function isEmpty(text) {
    return text === null || text === undefined || String(text).trim() === '';
  }

  function hasAny(text, words) {
    for (var i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  var ANY_WORDS = ['不限', '无限制', '无要求'];

  /* ---------------- 学历 ----------------
   * 真实取值：本科及以上/仅限本科/硕士研究生及以上/本科或硕士研究生/
   * 仅限硕士研究生/仅限博士研究生/大专及以上/仅限大专/大专或本科 */
  var EDU_TOKENS = [
    { re: /博士研究生|博士/, level: 4 },
    { re: /硕士研究生|硕士/, level: 3 },
    { re: /本科/, level: 2 },
    { re: /大专|专科/, level: 1 }
  ];

  function parseEducationReq(text) {
    if (isEmpty(text)) return { empty: true };
    var raw = String(text).trim();
    if (hasAny(raw, ANY_WORDS)) return { any: true };

    var levels = {};
    var matched = false;
    // 按「或」拆成若干子句，每句独立判断 仅限 / 及以上 / 单层
    var clauses = raw.split(/[或、，,；;]/);
    for (var i = 0; i < clauses.length; i++) {
      var c = clauses[i];
      if (!c) continue;
      for (var t = 0; t < EDU_TOKENS.length; t++) {
        if (EDU_TOKENS[t].re.test(c)) {
          matched = true;
          var lv = EDU_TOKENS[t].level;
          if (/及以上|以上/.test(c)) {
            for (var k = lv; k <= 4; k++) levels[k] = true;
          } else {
            levels[lv] = true; // 「仅限X」与裸「X」都是单层
          }
        }
      }
    }
    if (!matched) return null;
    var arr = Object.keys(levels).map(Number).sort(function (a, b) { return a - b; });
    return { levels: arr, raw: raw };
  }

  /* ---------------- 学位 ----------------
   * 真实取值：与最高学历相对应的学位/学士/硕士/博士/无要求 */
  function parseDegreeReq(text) {
    if (isEmpty(text)) return { empty: true };
    var raw = String(text).trim();
    if (hasAny(raw, ANY_WORDS)) return { any: true };
    if (raw.indexOf('与最高学历相对应') !== -1 || raw.indexOf('相对应的学位') !== -1) {
      return { corresponding: true, raw: raw };
    }
    var min = null;
    if (raw.indexOf('学士') !== -1) min = 1;
    if (raw.indexOf('硕士') !== -1) min = min === null ? 2 : Math.min(min, 2);
    if (raw.indexOf('博士') !== -1) min = min === null ? 3 : Math.min(min, 3);
    if (min === null) return null;
    return { minLevel: min, raw: raw };
  }

  /* ---------------- 政治面貌 ----------------
   * 真实取值：不限/中共党员/中共党员或共青团员 */
  function parsePoliticalReq(text) {
    if (isEmpty(text)) return { empty: true };
    var raw = String(text).trim();
    if (hasAny(raw, ANY_WORDS)) return { any: true };
    var allow = [];
    if (raw.indexOf('中共党员') !== -1 || raw.indexOf('党员') !== -1) allow.push('党员');
    if (raw.indexOf('共青团员') !== -1 || raw.indexOf('团员') !== -1) allow.push('团员');
    if (!allow.length) return null;
    return { allow: allow, raw: raw };
  }

  /* ---------------- 基层工作最低年限 ----------------
   * 真实取值：无限制/一年/二年/三年/五年以上；兼容 "2年"/"两年" */
  var CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  function parseExpYearsReq(text) {
    if (isEmpty(text)) return { empty: true };
    var raw = String(text).trim();
    if (hasAny(raw, ANY_WORDS)) return { any: true };
    var m = raw.match(/(\d+)\s*年/);
    if (m) return { minYears: parseInt(m[1], 10), raw: raw };
    m = raw.match(/([一二两三四五六七八九十])\s*年/);
    if (m) return { minYears: CN_NUM[m[1]], raw: raw };
    return null;
  }

  /* ---------------- 服务基层项目 ----------------
   * 「、」分隔的项目组合；逐段核对 patterns，识别不了的段记 unknown */
  function parseProjectReq(text) {
    if (isEmpty(text)) return { empty: true };
    var raw = String(text).trim();
    if (hasAny(raw, ANY_WORDS)) return { any: true };
    var types = cfg().PROJECT_TYPES || [];
    var projects = [];
    var segments = raw.split(/[、，,；;]/);
    var unknown = false;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i].trim();
      if (!seg) continue;
      var segMatched = false;
      for (var t = 0; t < types.length; t++) {
        var pats = types[t].patterns || [];
        for (var p = 0; p < pats.length; p++) {
          if (seg.indexOf(pats[p]) !== -1) {
            segMatched = true;
            if (projects.indexOf(types[t].key) === -1) projects.push(types[t].key);
            break;
          }
        }
      }
      if (!segMatched) unknown = true;
    }
    if (!projects.length && unknown) return null; // 整段无法识别 → 解析失败
    if (!projects.length) return null;
    return { projects: projects, unknown: unknown, raw: raw };
  }

  /* ---------------- 专业（分层分段 + item 代码提取） ----------------
   * 分段标记：本科：/大学本科：/专科：/大专： → undergrad
   *           研究生：/硕士：/硕士研究生：/博士：/博士研究生： → grad
   * 无标记部分 → general。item = {raw, code, codes, name, clean} */
  var SECTION_RE = /(硕士研究生|博士研究生|大学本科|研究生|本科|硕士|博士|专科|大专)\s*[：:]/g;

  function sectionOf(marker) {
    if (/^(研究生|硕士|博士)/.test(marker)) return 'grad';
    return 'undergrad'; // 本科/大学本科/专科/大专
  }

  /* 从单个 item 原文中提取 代码/名称 */
  function parseMajorItem(rawItem) {
    var raw = rawItem.trim();
    if (!raw) return null;
    var codes = [];
    var name = raw;

    // 1) 开头代码：030101K法学 / 0301法学 / 02经济学类 / 0351 法律
    var m = raw.match(/^(\d{6}[A-Za-z]?|\d{4}|\d{2})\s*/);
    if (m) {
      codes.push(m[1].toUpperCase());
      name = name.slice(m[0].length);
    }
    // 2) 括号内代码：电子信息类（0807）/ 法学（0301、0351）；括号内非代码（方向说明）则只删括号
    name = name.replace(/[（(]([^（）()]*)[）)]/g, function (whole, inner) {
      var innerCodes = inner.match(/\d{6}[A-Za-z]?|\d{4}|\d{2}/g);
      if (innerCodes) {
        for (var i = 0; i < innerCodes.length; i++) codes.push(innerCodes[i].toUpperCase());
        return '';
      }
      return ''; // 方向说明等，统一从名称中剔除（raw 仍保留原文）
    });
    // 去重
    var seen = {};
    codes = codes.filter(function (c) { if (seen[c]) return false; seen[c] = true; return true; });

    name = name.replace(/[\s　]+/g, '');
    // clean：去尾 类/专业（含「相关专业」「等」收尾），用于规范化比较
    var clean = name
      .replace(/(相关)?(类|专业)+$/, '')
      .replace(/等$/, '')
      .replace(/(相关)?(类|专业)+$/, '');
    return { raw: raw, code: codes.length ? codes[0] : '', codes: codes, name: name, clean: clean };
  }

  function parseMajorReq(text) {
    if (isEmpty(text)) return { empty: true };
    var raw = String(text).trim();
    if (hasAny(raw, ANY_WORDS)) return { any: true };

    var sections = {};
    var markers = [];
    var m;
    SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(raw)) !== null) {
      markers.push({ key: sectionOf(m[1]), end: m.index + m[0].length, start: m.index });
    }

    // 按 、，,；; 换行 分段，但括号内的分隔符不算（如 法学（0301、0351））
    function splitItems(body) {
      var parts = [];
      var depth = 0;
      var cur = '';
      for (var i = 0; i < body.length; i++) {
        var ch = body.charAt(i);
        if (ch === '（' || ch === '(') depth++;
        else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
        if (depth === 0 && (ch === '、' || ch === '，' || ch === ',' || ch === '；' || ch === ';' || ch === '\n' || ch === '\r')) {
          parts.push(cur); cur = '';
        } else {
          cur += ch;
        }
      }
      parts.push(cur);
      return parts;
    }

    function addItems(sectionKey, body) {
      if (!body) return;
      var parts = splitItems(body);
      for (var i = 0; i < parts.length; i++) {
        var item = parseMajorItem(parts[i]);
        if (item && (item.clean || item.code)) {
          if (!sections[sectionKey]) sections[sectionKey] = [];
          sections[sectionKey].push(item);
        }
      }
    }

    if (!markers.length) {
      addItems('general', raw);
    } else {
      if (markers[0].start > 0) addItems('general', raw.slice(0, markers[0].start));
      for (var i = 0; i < markers.length; i++) {
        var to = i + 1 < markers.length ? markers[i + 1].start : raw.length;
        addItems(markers[i].key, raw.slice(markers[i].end, to));
      }
    }

    var total = 0;
    for (var k in sections) total += sections[k].length;
    if (!total) return null;
    return { sections: sections, raw: raw };
  }

  /* 关键词规范化：去代码、去括号、去尾 类/专业（matching 也用，挂到 Normalize 上共享） */
  function normalizeKeyword(kw) {
    var s = String(kw || '').trim();
    s = s.replace(/^\d{6}[A-Za-z]?|^\d{4}|^\d{2}/, '');
    s = s.replace(/[（(][^（）()]*[）)]/g, '');
    s = s.replace(/[\s　]+/g, '');
    s = s.replace(/(相关)?(类|专业)+$/, '').replace(/等$/, '').replace(/(相关)?(类|专业)+$/, '');
    return s;
  }

  /* 提取关键词中的代码（≥2 位数字，可带结尾字母） */
  function extractCode(kw) {
    var m = String(kw || '').match(/\d{6}[A-Za-z]?|\d{4}|\d{2}/);
    return m ? m[0].toUpperCase() : '';
  }

  g.Normalize = {
    parseEducationReq: parseEducationReq,
    parseDegreeReq: parseDegreeReq,
    parsePoliticalReq: parsePoliticalReq,
    parseExpYearsReq: parseExpYearsReq,
    parseProjectReq: parseProjectReq,
    parseMajorReq: parseMajorReq,
    normalizeKeyword: normalizeKeyword,
    extractCode: extractCode
  };
})(typeof window !== 'undefined' ? window : globalThis);
