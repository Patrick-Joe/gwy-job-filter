/* =========================================================================
 * RawFilter — 原始条件筛选模式（Agent D）
 *
 * 契约（见 SPEC.md「模块接口契约」）：
 *   RawFilter.matchJob(job, conds)  → bool
 *     conds: {列名或 fieldKey: '关键词'}，全部 AND，大小写不敏感子串匹配；空条件视为通过
 *   RawFilter.matchJobs(jobs, conds) → 过滤后的新数组
 *
 * 键解析规则：
 *   1. 键本身是 job 的列名 → 直接对该列做子串匹配；
 *   2. 键是 APP_CONFIG.CORE_FIELDS 的 fieldKey（如 'major'/'education'）→
 *      按该字段 aliases 在 job 的实际列名中「精确 → 包含」匹配出真实列；
 *   3. 都解析不到 → 该条件视为不满足（用户对一个数据里不存在的列设了条件，结果为空）。
 *
 * 扩展（不改变契约签名）：conds 的特殊键 '*'（RawFilter.ANY_COLUMN）表示
 *   「任意列关键词」——对该行全部列值拼接后做子串匹配，对应界面上的 #rawKeyword。
 *
 * 浏览器 / node 双兼容。
 * ====================================================================== */
(function (g) {
  'use strict';

  var ANY_COLUMN = '*';

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  /* 把 conds 的键解析成 job 中真实存在的列名；解析不到返回 null */
  function resolveColumn(job, key) {
    if (has(job, key)) return key;
    var cfg = g.APP_CONFIG;
    if (!cfg || !cfg.CORE_FIELDS) return null;
    var field = null;
    for (var i = 0; i < cfg.CORE_FIELDS.length; i++) {
      if (cfg.CORE_FIELDS[i].key === key) { field = cfg.CORE_FIELDS[i]; break; }
    }
    if (!field) return null;
    var cols = Object.keys(job);
    var a, j, alias;
    /* 精确匹配优先 */
    for (a = 0; a < field.aliases.length; a++) {
      alias = field.aliases[a];
      for (j = 0; j < cols.length; j++) if (cols[j] === alias) return cols[j];
    }
    /* 再退到包含匹配 */
    for (a = 0; a < field.aliases.length; a++) {
      alias = field.aliases[a];
      for (j = 0; j < cols.length; j++) if (cols[j].indexOf(alias) !== -1) return cols[j];
    }
    return null;
  }

  /* 预处理 conds 为可执行条件数组（关键词统一小写化，空条件丢弃）。
   * 返回 null 表示存在无法解析的列 → 整体无结果。 */
  function compileConds(job, conds) {
    var out = [];
    if (!conds) return out;
    var keys = Object.keys(conds);
    for (var i = 0; i < keys.length; i++) {
      var kw = str(conds[keys[i]]).trim();
      if (!kw) continue; /* 空条件视为通过 */
      if (keys[i] === ANY_COLUMN) {
        out.push({ any: true, kw: kw.toLowerCase() });
        continue;
      }
      var col = resolveColumn(job, keys[i]);
      if (col === null) return null;
      out.push({ any: false, col: col, kw: kw.toLowerCase() });
    }
    return out;
  }

  /* 整行全部列值拼接（懒计算，仅在存在 '*' 条件时执行一次） */
  function joinJobValues(job) {
    var ks = Object.keys(job);
    var vals = new Array(ks.length);
    for (var i = 0; i < ks.length; i++) vals[i] = str(job[ks[i]]);
    return vals.join('\u0001').toLowerCase();
  }

  function runConds(job, compiled) {
    var joined = null;
    for (var i = 0; i < compiled.length; i++) {
      var c = compiled[i];
      if (c.any) {
        if (joined === null) joined = joinJobValues(job);
        if (joined.indexOf(c.kw) === -1) return false;
      } else {
        if (str(job[c.col]).toLowerCase().indexOf(c.kw) === -1) return false;
      }
    }
    return true;
  }

  function matchJob(job, conds) {
    if (!job || typeof job !== 'object') return false;
    var compiled = compileConds(job, conds);
    if (compiled === null) return false; /* 条件落在数据里不存在的列上 */
    return runConds(job, compiled);
  }

  function matchJobs(jobs, conds) {
    if (!jobs || typeof jobs.length !== 'number') return [];
    if (!jobs.length) return [];
    /* 同一批 job 共享同一组表头，键解析用首行做一次即可 */
    var compiled = compileConds(jobs[0], conds);
    if (compiled === null) return [];
    if (!compiled.length) return jobs.slice();
    var out = [];
    for (var i = 0; i < jobs.length; i++) {
      if (jobs[i] && typeof jobs[i] === 'object' && runConds(jobs[i], compiled)) out.push(jobs[i]);
    }
    return out;
  }

  g.RawFilter = {
    ANY_COLUMN: ANY_COLUMN,
    matchJob: matchJob,
    matchJobs: matchJobs,
    _resolveColumn: resolveColumn /* 暴露给调试/测试 */
  };
})(typeof window !== 'undefined' ? window : globalThis);
