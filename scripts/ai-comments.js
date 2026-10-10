/* 为 look-feed.json（看一看）与 official-feed.json（公众号主页）的每篇文章用 AI（SiliconFlow Qwen）
 * 生成贴合正文的真实感评论，写入 data/ai-review.json。前端 official.js 的 articleComments() 按 articleKey 读取。
 *
 * key 规则与前端完全一致： (account.id || account.name) + '#' + (article.id || article.title)
 * 评论结构： { name, text, likes, location, time, replies: [] }
 *
 * 设计：
 *  - 增量：已有 key 且含评论则跳过（除非 --force），重跑不会重复花钱 / 覆盖已有结果。
 *  - 并发：默认 6 并发，受 --conc 控制；失败（429/网络/解析失败）自动退避重试。
 *  - 省 token：模型只产出 name + text，likes/location/time 由脚本填（可控、合法）。
 *
 * 用法：
 *   node scripts/ai-comments.js                 # 为所有缺评论的文章生成
 *   node scripts/ai-comments.js --force         # 全部重生成（覆盖已有）
 *   node scripts/ai-comments.js --limit 50      # 只处理前 50 篇（调试）
 *   node scripts/ai-comments.js --conc 10       # 10 并发
 */

'use strict';
const fs = require('fs');
const path = require('path');

const BASE = process.env.SF_BASE || 'https://api.siliconflow.cn/v1';
const MODEL = process.env.SF_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

// 与前端 llm-config.js 同源取 key
function loadKey() {
  try {
    const cfg = fs.readFileSync(path.join(__dirname, 'llm-config.js'), 'utf8');
    const m = cfg.match(/key:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch (e) { /* ignore */ }
  return process.env.SF_KEY || '';
}
const KEY = loadKey();

const ROOT = path.join(__dirname, '..');
// 同时覆盖「看一看」(look-feed.json) 与「公众号主页」(official-feed.json) 两个数据源，
// 两者账号 id 前缀不同（w2r_ / oa_），key 不会冲突。
const FEEDS = [
  path.join(ROOT, 'data', 'look-feed.json'),
  path.join(ROOT, 'data', 'official-feed.json')
];
const OUT = path.join(ROOT, 'data', 'ai-review.json');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const concIdx = args.indexOf('--conc');
const CONC = Math.max(1, Math.min(20, concIdx >= 0 ? parseInt(args[concIdx + 1], 10) : 6));

if (!KEY) { console.error('[ai-comments] 未找到 SiliconFlow key（llm-config.js 或 SF_KEY）'); process.exit(2); }

// ---------- 读入已有评论（增量基准） ----------
let review = {};
try { review = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; }
catch (e) { review = {}; }

// ---------- 构造任务：遍历所有 feed ----------
const tasks = [];
for (const feedFile of FEEDS) {
  let feed;
  try { feed = JSON.parse(fs.readFileSync(feedFile, 'utf8')); }
  catch (e) { console.warn('[ai-comments] 读取失败，跳过:', feedFile, e.message); continue; }
  for (const acc of feed.accounts || []) {
    for (const art of acc.articles || []) {
      const key = (acc.id || acc.name) + '#' + (art.id || art.title);
      if (!FORCE && review[key] && review[key].comments && review[key].comments.length) continue;
      const title = art.title || '';
      const digest = art.summary || art.digest || '';
      let body = art.body || '';
      if (!body && Array.isArray(art.content)) body = art.content.map(b => (b && b.text) || '').join('\n');
      body = String(body).slice(0, 1000);
      tasks.push({ key, account: acc.name || '', title, digest, body });
      if (tasks.length >= LIMIT) break;
    }
    if (tasks.length >= LIMIT) break;
  }
  if (tasks.length >= LIMIT) break;
}

console.log(`[ai-comments] 待生成文章: ${tasks.length} 篇 (conc=${CONC}, force=${FORCE})`);

if (!tasks.length) {
  console.log('[ai-comments] 没有需要生成的文章，结束。');
  process.exit(0);
}

// ---------- 工具 ----------
const LOCATIONS = ['', '', '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '重庆', '苏州', '天津', '青岛', '郑州', '长沙', '沈阳'];
const TIMES = ['刚刚', '12分钟前', '1小时前', '2小时前', '3小时前', '今天', '昨天', '前天'];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去掉 markdown 代码围栏（```json ... ```）
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 1) 整体尝试解析（可能直接是数组，或 {comments:[...]} / {"评论":[...]} 包裹）
  try {
    const p = JSON.parse(s);
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.comments)) return p.comments;
    if (p && Array.isArray(p.评论)) return p.评论;
  } catch (e) { /* fall through */ }
  // 2) 截取第一个 [ 到最后一个 ]，再尝试（容忍前后多余文字）
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) {
    let seg = s.slice(a, b + 1);
    try { return JSON.parse(seg); } catch (e) { /* repair */ }
    // 3) 常见瑕疵修复：尾随逗号、引号内换行
    try {
      seg = seg
        .replace(/\}\s*,\s*(\]|\})/g, '$1')   // 尾随逗号
        .replace(/,\s*\]/g, ']')
        .replace(/\r?\n/g, ' ');              // 引号内换行转空格
      const fixed = JSON.parse(seg);
      if (Array.isArray(fixed)) return fixed;
    } catch (e) { /* give up */ }
  }
  return null;
}

// ---------- 单次调用（Node 内置 https，避免 shell 转义问题） ----------
const https = require('https');
function callModel(prompt) {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: '你是中文公众号评论区模拟器，只输出合法 JSON，不要任何解释文字。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.9,
    max_tokens: 600
  });
  const u = new URL(BASE + '/chat/completions');
  const body = Buffer.from(payload, 'utf8');
  const headers = {
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    'Content-Length': body.length
  };
  return new Promise((resolve, reject) => {
    let retries = 0;
    function attempt() {
      const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { /* not json */ }
          if (!parsed) { if (retries++ < 5) return setTimeout(attempt, 1000 * retries); return reject(new Error('bad response')); }
          // 余额不足：尽快退出，避免无谓重试
          if (parsed.error && parsed.error.code === 30001) return reject(new Error('402 余额不足'));
          if (parsed.error) {
            if (retries++ < 5) return setTimeout(attempt, 1200 * retries);
            return reject(new Error((parsed.error && parsed.error.message) || ('api ' + res.statusCode)));
          }
          const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
          if (!content) { if (retries++ < 5) return setTimeout(attempt, 1000 * retries); return reject(new Error('empty content')); }
          resolve(content);
        });
      });
      req.on('error', (e) => {
        if (retries++ < 3) return setTimeout(attempt, 800 * retries);
        reject(e);
      });
      req.setTimeout(30000, () => { req.destroy(); if (retries++ < 3) return setTimeout(attempt, 800 * retries); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    }
    attempt();
  });
}

function buildPrompt(t) {
  return [
    `下面是一篇公众号文章，请生成 4 条真实、口语化、观点各异的网友评论（类似微信留言），`,
    `不要空洞吹捧、不要重复、不要官方腔。返回 JSON 数组，每项形如 {"name":"简短网名(2-6字)","text":"评论内容(20-80字)"}。`,
    `只返回 JSON 数组，不要其他文字。`,
    ``,
    `标题：${t.title}`,
    t.digest ? `摘要：${t.digest}` : '',
    t.body ? `正文片段：\n${t.body}` : ''
  ].filter(Boolean).join('\n');
}

async function generateOne(t) {
  let lastErr;
  // 解析失败/无有效评论时重试整次调用（模型偶发返回非标准 JSON）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await callModel(buildPrompt(t));
      const arr = extractJson(content);
      if (!Array.isArray(arr) || !arr.length) { lastErr = new Error('parse fail'); continue; }
      const comments = arr
        .filter(c => c && c.text && String(c.text).trim().length >= 6)
        .slice(0, 6)
        .map(c => ({
          name: String(c.name || pick(['微信用户', '路人甲', '热心网友', '老周', '小李', '阿强', '王姐', '大壮', '陈先生', '风轻云淡'])).slice(0, 12),
          text: String(c.text).trim().slice(0, 200),
          likes: randInt(0, 320),
          location: pick(LOCATIONS),
          time: pick(TIMES),
          replies: []
        }));
      if (!comments.length) { lastErr = new Error('no valid comment'); continue; }
      return comments;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('generate failed');
}

// ---------- 并发执行 ----------

// 合并写盘：以磁盘当前文件为基底合并，避免并发/中途进程覆盖导致已生成条目丢失
function safeWrite(obj) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch (e) { /* 空文件 */ }
  const merged = Object.assign({}, cur, obj);
  fs.writeFileSync(OUT, JSON.stringify(merged, null, 0));
}

let done = 0, failed = 0;
const total = tasks.length;
let idx = 0;

async function worker() {
  while (idx < tasks.length) {
    const i = idx++;
    const t = tasks[i];
    try {
      const comments = await generateOne(t);
      review[t.key] = { comments };
      done++;
      if (done % 20 === 0 || done === total) {
        console.log(`[ai-comments] 进度 ${done}/${total} 成功 | 失败 ${failed}`);
        safeWrite(review);
      }
    } catch (e) {
      failed++;
      console.warn(`[ai-comments] 失败(${t.key}): ${e.message}`);
    }
  }
}

(async function main() {
  const workers = [];
  for (let w = 0; w < CONC; w++) workers.push(worker());
  await Promise.all(workers);
  safeWrite(review);
  console.log(`[ai-comments] 完成。成功 ${done} / ${total}，失败 ${failed}。输出: ${OUT}`);
})();
