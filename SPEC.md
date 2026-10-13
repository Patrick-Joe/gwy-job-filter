# 公务员岗位智能筛选系统 — 架构规范（所有开发 agent 必读）

## 项目概述

纯前端（HTML5 + CSS3 + 原生 JS）公务员/事业单位招聘岗位智能筛选系统。用户导入 Excel 岗位表（.xlsx/.xls/.csv），填写自身条件，系统逐岗位判断 ✅符合 / ❌不符合 / ⚠️需人工核实。

**硬性约束：**
- 页面通过 `file://` 直接双击打开必须可用 → **禁止 ES modules / fetch 本地文件**，全部用普通 `<script>` 全局命名空间。
- SheetJS 已本地化：`libs/xlsx.full.min.js`（全局变量 `XLSX`）。**不要**再引 CDN 版。
- 字体走 Google Fonts CDN 但必须有系统字体 fallback，离线时样式不崩。
- 原始数据一字不改（专业代码前导零、长文本必须保留）。所有单元格读出来统一转字符串。
- 19,426 行数据不得卡 UI：筛选/渲染用分块异步（`await new Promise(r=>setTimeout(r))` 每 500~1000 行让出一次）。
- 界面风格：**新粗野主义（Neo-Brutalism）**，设计 token 见本文末节。

## 目录与文件分工

```
job-filter/
├── index.html          ← Agent C：页面结构（含所有 <script> 引用、元素 ID 契约）
├── css/style.css       ← Agent C：新粗野主义全部样式
├── js/config.js        ← 已存在（主 agent 写好，所有人只读使用，不要改）
├── js/normalize.js     ← Agent A：单元格文本 → 结构化规则  window.Normalize
├── js/matching.js      ← Agent A：智能资格匹配引擎        window.Matcher
├── js/excel.js         ← Agent B：文件解析+字段映射        window.ExcelModule
├── js/export.js        ← Agent B：结果导出 xlsx           window.Exporter
├── js/rawfilter.js     ← Agent D：原始条件筛选模式        window.RawFilter
├── js/table.js         ← Agent D：结果表格渲染            window.ResultTable
├── js/main.js          ← 集成阶段编写（Agent A~D 不要写）
├── testdata/样本岗位.csv   ← 80 行多样本（含全部稀有取值）
├── testdata/全量岗位.csv   ← 19,426 行全量（首列"来源类别"为多出的列）
└── testdata/2027国考招考简章.xls ← 真实原始文件（4 个 sheet）
```

**script 加载顺序（index.html 中）：** `libs/xlsx.full.min.js` → `js/config.js` → `js/normalize.js` → `js/matching.js` → `js/excel.js` → `js/export.js` → `js/rawfilter.js` → `js/table.js` → `js/main.js`

## 真实数据事实（来自 2027 国考简章，19,426 条，27 列 + 表头在第 2 行，第 1 行是说明文字）

列：部门代码/部门名称/用人司局/机构性质/招考职位/职位属性/职位分布/职位简介/职位代码/机构层级/考试类别/招考人数/**专业/学历/学位/政治面貌/基层工作最低年限/服务基层项目工作经历**/是否在面试阶段组织专业能力测试/面试人员比例/工作地点/落户地点/备注/部门网站/咨询电话1/2/3

**学历** 全部取值：本科及以上(13492)、仅限本科(2687)、硕士研究生及以上(1973)、本科或硕士研究生(881)、仅限硕士研究生(357)、仅限博士研究生(21)、大专及以上(7)、仅限大专(7)、大专或本科(1)
**学位** 全部取值：与最高学历相对应的学位(16457)、学士(2636)、硕士(308)、博士(18)、无要求(7)
**政治面貌** 全部取值：不限、中共党员、中共党员或共青团员
**基层工作最低年限** 全部取值：无限制、二年、三年、一年、五年以上
**服务基层项目**：无限制，或「大学生村官 / “三支一扶”计划 / 大学生志愿服务西部计划 / 农村义务教育阶段学校教师特设岗位计划 / 在军队服役5年（含）以上的高校毕业生退役士兵」的「、」分隔组合
**专业** 形态多样（必须都能解析）：
- `数学类、统计学类、电子信息类、计算机类`
- `0101哲学、0301法学、0351法律、0501中国语言文学`
- `本科：朝鲜语050209；研究生：朝鲜语口译、朝鲜语笔译`
- `大学本科：电子信息类（0807）、计算机类（0809）；研究生：电子科学与技术（0809）、信息与通信工程（0810）`
- `本科：运动训练（040202K）、体育教育（040201）硕士：体育教育训练学（040303）、体育（045200）`（注意无分号、用"硕士："）
- `本科：统计学、应用统计学、数据科学 研究生：统计学`（空格分隔两段）
- `0303社会学（老年学、老龄研究等方向）`（括号内是方向说明，非代码）
- `中国语言文学类、英语相关专业`

## 模块接口契约

### `window.APP_CONFIG`（js/config.js，已写好）
```js
{
  CORE_FIELDS: [{key:'major',label:'专业',aliases:[...]}, ...],  // 6 个核心字段及列名别名
  EDU_LEVELS: {大专:1, 本科:2, 硕士研究生:3, 博士研究生:4},
  DEGREE_LEVELS: {学士:1, 硕士:2, 博士:3},
  PROJECT_TYPES: [{key:'cunguan', label:'大学生村官', patterns:[...]}, ...], // 含退役士兵
  MAJOR_CATEGORY_MAP: {'0301':{name:'法学类/法学',...}, ...}, // 常见专业代码类别映射
  STORAGE_KEY: 'gwyFilterPresets.v1'
}
```

### `window.Normalize`（Agent A）
全部函数输入字符串（可能为空串），输出结构化对象；**解析不了返回 null，绝不猜**。
```js
parseEducationReq(text)  → {any:true} | {levels:[2,3,4], raw} | null
parseDegreeReq(text)     → {any:true} | {minLevel:1|2|3, raw} | {corresponding:true, raw} | null
parsePoliticalReq(text)  → {any:true} | {allow:['党员','团员'], raw} | null
parseExpYearsReq(text)   → {any:true} | {minYears:Number, raw} | null   // "二年"/"2年"/"两年"→2；"五年以上"→5
parseProjectReq(text)    → {any:true} | {projects:['cunguan',...], unknown:false, raw} | null
parseMajorReq(text)      → {sections:{undergrad?:[item], grad?:[item], general?:[item]}, raw} | null
  // item = {raw:'030101K法学', code:'030101K', name:'法学', clean:'法学'}
  // 分段识别："本科：""大学本科：""专科："(→undergrad)；"研究生：""硕士：""硕士研究生：""博士："(→grad)；分隔符 ；; 或直接空格/换行
  // 无分段标记 → general。每个 item 提取代码（6位数字+可选字母，或括号内代码）与名称
```
空白/空串 → 所有函数返回 `{empty:true}` 标记对象（由 Matcher 判为 ⚠️ 待核实，**不是**无限制）。
"无限制"/"不限"/"无要求" → `{any:true}`。

### `window.Matcher`（Agent A）
```js
matchJob(job, userCond, mapping) → {
  overall: 'match'|'nomatch'|'unknown',
  fields: { major:{status,reason}, education:{status,reason}, degree:{...}, political:{...}, expYears:{...}, project:{...} }
}
// job: 行对象（按表头为键的字符串字典）；mapping: {major:'专业', education:'学历', ...} 列名映射
// userCond = {
//   majorKeywords:['法学','0301'], majorMode:'fuzzy'|'exact',
//   education:0|1|2|3|4,     // 0=不限 1=专科 2=本科 3=硕士 4=博士（用户实际学历）
//   degree:0|1|2|3,          // 0=不限 1=学士 2=硕士 3=博士
//   political:'',            // ''=不限 | '党员'|'预备党员'|'团员'|'群众'
//   expYears:-1,             // -1=不限 0=无经历 1..4=年限 5=5年及以上
//   projects:['cunguan']     // 用户具有的服务基层项目（可多选），[]含"无相关经历"
// }
```
**判断规则（逐字段，status: 'match'|'nomatch'|'unknown'，reason 给用户看的中文说明）：**

1. **学历**：userCond.education=0 → match。否则 parseEducationReq；any→match；levels 含用户层级→match，否则 nomatch（reason 如"岗位要求仅限本科，用户为硕士研究生"）；null→unknown。
2. **学位**：user.degree=0 → match。any→match；minLevel→用户学位层级≥要求→match 否则 nomatch；corresponding→按对应关系判断：本科↔学士、硕士↔硕士、博士↔博士、专科（无学位）→match；用户 学历-学位 不对应→nomatch（reason 说明"岗位要求与最高学历相对应的学位，用户硕士研究生+学士不对应"）。学历学位分别判断，不默认必然对应。
3. **政治面貌**：user 不限→match。any→match。allow 含用户身份→match。「中共党员」要求 vs 用户「预备党员」→ **unknown（需人工核实，依公告规定）**；「中共党员或共青团员」vs「预备党员」→ unknown。群众 vs 任何限定→nomatch。
4. **基层工作年限**：user=-1→match。any→match。用户年限≥minYears→match，否则 nomatch（reason 带双方数值）。
5. **服务基层项目**：any→match。岗位列出项目集合：用户 projects 与之有交集→match；无交集→nomatch；岗位要求中含无法识别的项目文本（unknown=true）且交集为空→unknown。
6. **专业（分层匹配，最重要）**：
   - 用户未填关键词→match。
   - 有 sections.undergrad/grad 时，按用户学历选段：专科/本科→undergrad；硕士/博士→grad；用户学历=0（不限）→合并全部段。对应段缺失→fallback 用 general 或全部段，并在 reason 注明。
   - 对该段 items 做关键词匹配，**任一关键词命中即 match**：
     - fuzzy：双向处理——关键词去尾（类/专业）后做子串匹配 item.clean 或 item.raw；关键词含 ≥2 位数字 → 同时做代码匹配：item.code 与关键词代码互为前缀（如 0301↔030101K，类别↔具体专业），命中→match，reason 注明经由类别映射；代码无法在 MAJOR_CATEGORY_MAP 验证的前缀匹配→status 降为 unknown 不可靠时，否则 match。
     - exact：item.clean === 关键词（去尾/去括号规范化后）。
   - 全部不命中→nomatch（reason 列出岗位该段原文摘要）；parseMajorReq=null→unknown；empty→unknown（"岗位专业要求空白，待核实"）。
7. **overall**：任一字段 nomatch→'nomatch'；否则任一 unknown→'unknown'；否则 'match'。

`Matcher` 还必须暴露 `matchJobsChunked(jobs, userCond, mapping, onProgress) → Promise<results[]>`，内部每 800 行让出主线程并回调 onProgress(done,total)。

**必须环境无关**：`typeof window==='undefined'` 时挂到 `globalThis`，便于 node 测试。

### `window.ExcelModule`（Agent B）
```js
parseFile(file) → Promise<{sheets:[{name, headers:[], rows:[{}]}], errors:[]}>
  // 用 XLSX.read(arrayBuffer, {type:'array', raw:true, cellText:true})；每个 sheet 自动探测表头行
  // （前 5 行中含 ≥2 个核心字段别名的行），其上是说明行要跳过；空 sheet 跳过。
  // 所有值转字符串（防止 030101K 变数字丢前导零——用 cellText/格式化文本）。行对象键=表头原文。
detectMapping(headers) → {major:'专业'|null, education:..., degree:..., political:..., expYears:..., project:...}
  // 按 APP_CONFIG.CORE_FIELDS[].aliases 精确→包含 匹配
```
CSV 文件也要支持（XLSX.read 可直接读 csv 文本）。

### `window.Exporter`（Agent B）
```js
exportXlsx(rows, columns, filename)  // rows: 平面对象数组（含匹配状态/原因列），用 XLSX.utils.json_to_sheet + writeFile
```

### `window.RawFilter`（Agent D）
```js
matchJob(job, conds) → bool   // conds: {列名或 fieldKey: '关键词'}，全部 AND，大小写不敏感子串匹配；空条件视为通过
matchJobs(jobs, conds) → jobs.filter(...)
```

### `window.ResultTable`（Agent D）
```js
init(containerEl, {onRowClick})
setData(entries)  // entries: [{job, result, rawText}]，result 可为 null（raw 模式）
  // 功能：分页（50/100/200 可选）、多列排序（点击表头，shift=叠加）、每列顶部关键词过滤、
  //       横向滚动、长文本截断（title 悬浮全文+点击展开）、匹配状态列固定在最左、表头 sticky
  // 渲染必须分块（DocumentFragment + 每 200 行 await 让出），1.9 万行不卡
```

## index.html 元素 ID 契约（Agent C 必须实现这些 ID，集成阶段 main.js 直接绑定）

- `#fileInput`（hidden file input）、`#dropZone`（拖拽区，内含「选择文件」按钮 `#btnPickFile`）
- `#fileInfo`（已导入文件名+岗位总数）、`#btnReupload`、`#btnMapping`（打开字段映射）
- `#mappingModal`（模态框：6 个字段各一个 `<select id="map-major">` 等 + `#btnMappingSave` `#btnMappingClose`）
- `#sheetSelect`（sheet 筛选下拉，含"全部"）
- 模式选项卡：`#tabSmart`、`#tabRaw`（按钮）
- 智能模式面板 `#panelSmart`：
  - `#inputMajor`（文本，多关键词逗号/空格分隔）、`#majorMode`（select：fuzzy/exact）
  - `#selEducation`（select：0/1/2/3/4）、`#selDegree`（0..3）、`#selPolitical`（''/党员/预备党员/团员/群众）
  - `#selExpYears`（-1/0/1/2/3/4/5）、`#projectChecks`（多选 checkbox 组：cunguan/sanzhifu/xibu/tegang/tuiyi/none）
- 原始模式面板 `#panelRaw`：6 个文本输入 `#raw-major` `#raw-education` `#raw-degree` `#raw-political` `#raw-expYears` `#raw-project` + 任意列关键词 `#rawKeyword`
- `#btnClear`（一键清空）、`#btnSavePreset`、`#selPreset`（localStorage 方案恢复）、`#filterTags`（当前条件标签容器）
- 统计条：`#statTotal` `#statMatch` `#statUnknown` `#statNomatch`
- `#tableContainer`、`#btnExport`、`#loadingOverlay`（内含 `#loadingText`）
- 详情抽屉 `#detailDrawer`（`#detailBody`、`#btnDrawerClose`）

## 新粗野主义设计 token（Agent C 严格照用）

```css
:root{--bg:#f2f0e4;--panel:#e8e6d9;--paper:#fff;--dark:#1c1917;--ink:#292524;
--orange:#ea580c;--yellow:#eab308;--green:#65a30d;--red:#dc2626;--blue:#2563eb;
--shadow:#1c1917;--border:#1c1917}
```
- 全部 2-3px 实线边框、**零圆角**、硬阴影（`box-shadow:3px 3px 0 0 var(--shadow)`，hover 上浮 +1px、active 下沉归零）
- 字体：`'Space Grotesk','Noto Sans SC',sans-serif`（正文）/ `'Space Mono',monospace`（数据/标签），H2 用 uppercase+letter-spacing:2px
- 背景网格 `.grid-bg`（40px 网格，opacity 0.04）
- 匹配状态配色：✅ green、❌ red（淡化行）、⚠️ yellow；主按钮橙色
- 紧凑密度：卡片 padding 12px、正文 14px、表格 11px、表格可横向滚动
- 桌面端 6 个筛选条件排 1~2 行（grid auto-fit）；≥1400px 与 1200px 断点适配

## 验证要求（每个 agent 完成前必做）

- Agent A：写 `test/matching.test.js`（node 直接可跑，`require('../js/normalize.js'); require('../js/matching.js')`），断言覆盖：学历 9 种取值×用户硕士矩阵（题述表格：仅限本科❌、本科或硕士✅、仅限硕士✅、硕士及以上✅、仅限博士❌）、"与最高学历相对应的学位"对应/不对应、预备党员⚠️、群众❌、"二年/2年/两年/五年以上"年限比较、专业分层（"本科：0301法学类；研究生：0301法学"×法学硕士→按研究生段✅；本科段符合但研究生段不符→❌）、代码类别（0301↔030101K）、"英语相关专业"模糊命中、空白专业→⚠️。**全部用样本 CSV 里出现过的真实表达**。跑 `node test/matching.test.js` 全绿才算完成。
- Agent B：写 `test/excel.test.html` 或 node 脚本验证（node 下用 `require('../libs/xlsx.full.min.js')` 读 `testdata/2027国考招考简章.xls`，验证 4 sheet 全解析、表头探测正确、19426 行、专业代码前导零保留如 "0301"）。
- Agent C：页面用浏览器打开目测布局（提供 `index.html` 即可，集成阶段联调）。
- Agent D：table.js 用 node 不可行，写 `test/table.test.html` 手工验证页（内嵌 1000 行假数据渲染验证分页/排序/过滤）。

## 禁止事项

- 禁止 React/Vue/jQuery/任何构建步骤；禁止把 6 字段以外的列丢掉（原始列全部展示在结果表）。
- 禁止将空白单元格当无限制；禁止用纯数字前缀代替代码映射而不查 MAJOR_CATEGORY_MAP。
- 各 agent **只写自己名下的文件**，接口以本文档为准，不要改 config.js / SPEC.md / index.html（Agent C 除外）。
