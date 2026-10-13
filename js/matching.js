/* js/matching.js — 智能资格匹配引擎（window.Matcher）
 * 逐字段判断 match/nomatch/unknown + 中文 reason；overall 按
 * 「任一 nomatch → nomatch，否则任一 unknown → unknown，否则 match」聚合。
 * matchJobsChunked 每 800 行让出主线程并回调 onProgress。
 * 环境无关：浏览器挂 window，node 挂 globalThis。
 */
(function (g) {
  'use strict';

  function cfg() { return g.APP_CONFIG || {}; }
  function N() { return g.Normalize; }

  function eduName(lv) {
    var names = cfg().EDU_LEVEL_NAMES || {};
    return names[lv] || String(lv);
  }
  function degreeName(lv) {
    var names = cfg().DEGREE_LEVEL_NAMES || {};
    return names[lv] || String(lv);
  }
  function politicalName(v) {
    var map = { '': '不限', '党员': '中共党员', '预备党员': '中共预备党员', '团员': '共青团员', '群众': '群众' };
    return map[v] !== undefined ? map[v] : v;
  }
  function projectLabel(key) {
    var types = cfg().PROJECT_TYPES || [];
    for (var i = 0; i < types.length; i++) if (types[i].key === key) return types[i].label;
    return key;
  }

  function cell(job, mapping, key) {
    var col = mapping && mapping[key];
    if (!col) return '';
    var v = job[col];
    return v === null || v === undefined ? '' : String(v);
  }

  /* ---------- 1. 学历 ---------- */
  function matchEducation(user, text) {
    if (!user.education) return { status: 'match', reason: '用户学历不限，通过' };
    var p = N().parseEducationReq(text);
    if (p && p.empty) return { status: 'unknown', reason: '岗位学历要求空白，待核实' };
    if (!p) return { status: 'unknown', reason: '岗位学历要求无法解析：「' + text + '」，待核实' };
    if (p.any) return { status: 'match', reason: '岗位学历不限，用户' + eduName(user.education) + '符合' };
    if (p.levels.indexOf(user.education) !== -1) {
      return { status: 'match', reason: '岗位要求' + p.raw + '，用户' + eduName(user.education) + '符合' };
    }
    return { status: 'nomatch', reason: '岗位要求' + p.raw + '，用户为' + eduName(user.education) + '，不符合' };
  }

  /* ---------- 2. 学位 ---------- */
  function matchDegree(user, text) {
    if (!user.degree) return { status: 'match', reason: '用户学位不限，通过' };
    var p = N().parseDegreeReq(text);
    if (p && p.empty) return { status: 'unknown', reason: '岗位学位要求空白，待核实' };
    if (!p) return { status: 'unknown', reason: '岗位学位要求无法解析：「' + text + '」，待核实' };
    if (p.any) return { status: 'match', reason: '岗位学位无要求，用户' + degreeName(user.degree) + '符合' };
    if (p.minLevel) {
      if (user.degree >= p.minLevel) {
        return { status: 'match', reason: '岗位要求' + p.raw + '学位，用户' + degreeName(user.degree) + '符合' };
      }
      return { status: 'nomatch', reason: '岗位要求' + p.raw + '学位，用户为' + degreeName(user.degree) + '，不符合' };
    }
    if (p.corresponding) {
      if (!user.education) {
        return { status: 'unknown', reason: '岗位要求与最高学历相对应的学位，用户未填学历，无法核对，待核实' };
      }
      var expect = (cfg().EDU_TO_DEGREE || {})[user.education];
      if (expect === 0) {
        return { status: 'match', reason: '岗位要求与最高学历相对应的学位，用户为专科（无学位要求），符合' };
      }
      if (user.degree === expect) {
        return { status: 'match', reason: '岗位要求与最高学历相对应的学位，用户' + eduName(user.education) + '＋' + degreeName(user.degree) + '相对应，符合' };
      }
      return { status: 'nomatch', reason: '岗位要求与最高学历相对应的学位，用户' + eduName(user.education) + '＋' + degreeName(user.degree) + '不对应，不符合' };
    }
    return { status: 'unknown', reason: '岗位学位要求无法解析：「' + text + '」，待核实' };
  }

  /* ---------- 3. 政治面貌 ---------- */
  function matchPolitical(user, text) {
    if (!user.political) return { status: 'match', reason: '用户政治面貌不限，通过' };
    var p = N().parsePoliticalReq(text);
    if (p && p.empty) return { status: 'unknown', reason: '岗位政治面貌要求空白，待核实' };
    if (!p) return { status: 'unknown', reason: '岗位政治面貌要求无法解析：「' + text + '」，待核实' };
    if (p.any) return { status: 'match', reason: '岗位政治面貌不限，用户' + politicalName(user.political) + '符合' };
    if (p.allow.indexOf(user.political) !== -1) {
      return { status: 'match', reason: '岗位要求' + p.raw + '，用户' + politicalName(user.political) + '符合' };
    }
    if (user.political === '预备党员' && p.allow.indexOf('党员') !== -1) {
      return { status: 'unknown', reason: '岗位要求' + p.raw + '，用户为中共预备党员，是否视为符合需依公告规定，需人工核实' };
    }
    return { status: 'nomatch', reason: '岗位要求' + p.raw + '，用户为' + politicalName(user.political) + '，不符合' };
  }

  /* ---------- 4. 基层工作最低年限 ---------- */
  function matchExpYears(user, text) {
    if (user.expYears === -1 || user.expYears === undefined || user.expYears === null) {
      return { status: 'match', reason: '用户基层年限不限，通过' };
    }
    var p = N().parseExpYearsReq(text);
    if (p && p.empty) return { status: 'unknown', reason: '岗位基层工作年限要求空白，待核实' };
    if (!p) return { status: 'unknown', reason: '岗位基层工作年限要求无法解析：「' + text + '」，待核实' };
    if (p.any) return { status: 'match', reason: '岗位基层工作年限无限制，符合' };
    if (user.expYears >= p.minYears) {
      return { status: 'match', reason: '岗位要求基层工作最低' + p.minYears + '年，用户' + user.expYears + '年，符合' };
    }
    return { status: 'nomatch', reason: '岗位要求基层工作最低' + p.minYears + '年，用户为' + user.expYears + '年，不符合' };
  }

  /* ---------- 5. 服务基层项目 ---------- */
  function matchProject(user, text) {
    /* projects 显式为 null 表示用户选择"不限"，跳过该条件；[] 或缺省表示"无相关经历" */
    if (user.projects === null) {
      return { status: 'match', reason: '用户服务基层项目不限，通过' };
    }
    var p = N().parseProjectReq(text);
    if (p && p.empty) return { status: 'unknown', reason: '岗位服务基层项目要求空白，待核实' };
    if (!p) return { status: 'unknown', reason: '岗位服务基层项目要求无法解析：「' + text + '」，待核实' };
    if (p.any) return { status: 'match', reason: '岗位服务基层项目无限制，符合' };
    var userProjects = user.projects || [];
    var hit = [];
    for (var i = 0; i < userProjects.length; i++) {
      if (p.projects.indexOf(userProjects[i]) !== -1) hit.push(userProjects[i]);
    }
    var reqLabels = p.projects.map(projectLabel).join('、');
    if (hit.length) {
      return { status: 'match', reason: '岗位要求服务基层项目：' + reqLabels + '，用户具有' + hit.map(projectLabel).join('、') + '，符合' };
    }
    if (p.unknown) {
      return { status: 'unknown', reason: '岗位要求服务基层项目：' + p.raw + '，其中含无法识别的项目文本，且与用户经历无交集，需人工核实' };
    }
    var userDesc = userProjects.length ? userProjects.map(projectLabel).join('、') : '无相关经历';
    return { status: 'nomatch', reason: '岗位要求服务基层项目：' + reqLabels + '，用户为' + userDesc + '，无交集，不符合' };
  }

  /* ---------- 6. 专业（分层匹配） ---------- */
  function allItems(sections) {
    var out = [];
    ['undergrad', 'grad', 'general'].forEach(function (k) {
      if (sections[k]) out = out.concat(sections[k]);
    });
    return out;
  }

  function pickSection(sections, userEdu) {
    // 返回 {items, label, fallbackNote}
    var want = userEdu === 3 || userEdu === 4 ? 'grad'
      : userEdu === 1 || userEdu === 2 ? 'undergrad' : null;
    var label = want === 'grad' ? '研究生段' : '本科段';
    if (want && sections[want] && sections[want].length) {
      return { items: sections[want], label: label, fallbackNote: '' };
    }
    if (!want) return { items: allItems(sections), label: '全部段', fallbackNote: '' }; // 用户学历不限 → 合并
    // 对应段缺失 → fallback：general 优先，否则全部段
    if (sections.general && sections.general.length) {
      return { items: sections.general, label: '通用段', fallbackNote: '（岗位无' + label + '，按通用段匹配）' };
    }
    return { items: allItems(sections), label: '全部段', fallbackNote: '（岗位无' + label + '，按全部段匹配）' };
  }

  function verifyPrefix(shortCode) {
    // 类别代码必须在 MAJOR_CATEGORY_MAP 中可查，否则前缀匹配不可靠
    var map = cfg().MAJOR_CATEGORY_MAP || {};
    return Object.prototype.hasOwnProperty.call(map, shortCode);
  }

  function matchMajorItem(item, kw, mode) {
    // 返回 null=不命中 | {status, via}
    var kwClean = N().normalizeKeyword(kw);
    if (mode === 'exact') {
      if (item.clean && item.clean === kwClean) return { status: 'match', via: '名称精确相符' };
      return null;
    }
    // fuzzy：去尾后双向子串（item.clean ↔ 关键词），或对 raw 做原样子串
    if (kwClean && item.clean) {
      if (item.clean.indexOf(kwClean) !== -1) return { status: 'match', via: '名称模糊相符' };
      if (item.clean.length >= 2 && kwClean.indexOf(item.clean) !== -1) {
        return { status: 'match', via: '名称模糊相符' };
      }
    }
    if (kw && item.raw.indexOf(kw) !== -1) return { status: 'match', via: '原文包含关键词' };
    // 代码匹配：关键词含 ≥2 位数字，item 代码与关键词代码互为前缀
    var kwCode = N().extractCode(kw);
    if (kwCode) {
      var codes = item.codes && item.codes.length ? item.codes : (item.code ? [item.code] : []);
      for (var i = 0; i < codes.length; i++) {
        var c = codes[i];
        if (c === kwCode) return { status: 'match', via: '代码相同（' + c + '）' };
        if (c.length >= 2 && kwCode.length >= 2 && (c.indexOf(kwCode) === 0 || kwCode.indexOf(c) === 0)) {
          var short = c.length <= kwCode.length ? c : kwCode;
          var long = c.length <= kwCode.length ? kwCode : c;
          if (verifyPrefix(short)) {
            var cat = (cfg().MAJOR_CATEGORY_MAP || {})[short];
            return { status: 'match', via: '代码前缀相符（' + short + '↔' + long + '，类别：' + cat + '）' };
          }
          return { status: 'unknown', via: '代码前缀相符（' + short + '↔' + long + '），但 ' + short + ' 不在类别映射表中，无法核实归属' };
        }
      }
    }
    return null;
  }

  function matchMajor(user, text) {
    var keywords = user.majorKeywords || [];
    if (!keywords.length) return { status: 'match', reason: '用户未填专业关键词，通过' };
    var p = N().parseMajorReq(text);
    if (p && p.empty) return { status: 'unknown', reason: '岗位专业要求空白，待核实' };
    if (!p) return { status: 'unknown', reason: '岗位专业要求无法解析：「' + String(text).slice(0, 60) + '」，待核实' };
    if (p.any) return { status: 'match', reason: '岗位专业不限，符合' };

    var pick = pickSection(p.sections, user.education);
    var unknownHit = null;
    for (var k = 0; k < keywords.length; k++) {
      var kw = String(keywords[k]).trim();
      if (!kw) continue;
      for (var i = 0; i < pick.items.length; i++) {
        var r = matchMajorItem(pick.items[i], kw, user.majorMode === 'exact' ? 'exact' : 'fuzzy');
        if (r && r.status === 'match') {
          return {
            status: 'match',
            reason: '专业匹配：' + pick.label + '「' + pick.items[i].raw + '」命中关键词「' + kw + '」（' + r.via + '）' + pick.fallbackNote
          };
        }
        if (r && r.status === 'unknown' && !unknownHit) {
          unknownHit = { item: pick.items[i], kw: kw, via: r.via };
        }
      }
    }
    if (unknownHit) {
      return {
        status: 'unknown',
        reason: '专业待核实：' + pick.label + '「' + unknownHit.item.raw + '」与关键词「' + unknownHit.kw + '」' + unknownHit.via + pick.fallbackNote
      };
    }
    var summary = p.raw.length > 60 ? p.raw.slice(0, 60) + '…' : p.raw;
    return {
      status: 'nomatch',
      reason: '专业不符合：关键词「' + keywords.join('、') + '」均未命中岗位' + pick.label + '（' + summary + '）' + pick.fallbackNote
    };
  }

  /* ---------- 汇总 ---------- */
  function matchJob(job, userCond, mapping) {
    var fields = {
      major: matchMajor(userCond, cell(job, mapping, 'major')),
      education: matchEducation(userCond, cell(job, mapping, 'education')),
      degree: matchDegree(userCond, cell(job, mapping, 'degree')),
      political: matchPolitical(userCond, cell(job, mapping, 'political')),
      expYears: matchExpYears(userCond, cell(job, mapping, 'expYears')),
      project: matchProject(userCond, cell(job, mapping, 'project'))
    };
    var overall = 'match';
    for (var k in fields) {
      if (fields[k].status === 'nomatch') { overall = 'nomatch'; break; }
      if (fields[k].status === 'unknown') overall = 'unknown';
    }
    return { overall: overall, fields: fields };
  }

  function matchJobsChunked(jobs, userCond, mapping, onProgress) {
    var results = new Array(jobs.length);
    var i = 0;
    var total = jobs.length;
    function step() {
      var end = Math.min(i + 800, total);
      for (; i < end; i++) results[i] = matchJob(jobs[i], userCond, mapping);
      if (typeof onProgress === 'function') onProgress(i, total);
      if (i < total) return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(step);
      return results;
    }
    return Promise.resolve().then(step);
  }

  g.Matcher = { matchJob: matchJob, matchJobsChunked: matchJobsChunked };
})(typeof window !== 'undefined' ? window : globalThis);
