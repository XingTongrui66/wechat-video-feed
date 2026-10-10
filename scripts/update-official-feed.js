#!/usr/bin/env node
'use strict';

/* ===== 公众号内容源抓取器（中老年男性向版）=====
   功能：
   1. 从指定 RSS 源抓取文章
   2. 按 topic 和关键词过滤，确保题材符合中老年男性阅读偏好
   3. 抓取失败时使用历史池兜底
   4. 每日合成 2-3 篇原创风格文章（养生/财经/汽车等话题）
   5. 评论昵称和话术改为中老年男性风格
   6. 输出 official-feed.json 供微信前端使用 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const https = require('https');
const { URL } = require('url');
// 规则筛选直通（2026-10-09 起）：原 AI 筛选闸门（ai-filter.js，调 SiliconFlow）已移除——
// SiliconFlow 账户欠费、AI 全链路停用，故不再调用任何模型。这里只按正文长度做"短文转快讯"
// 分流，其余文章全部保留；抓取阶段的规则清洗（BAD_DOMAINS / 模板图 / 文末模板行）已兜底质量。
function filterArticles(allRanked) {
  const m = new Map();
  allRanked.forEach(function (a) {
    const len = (a && a.body || '').length;
    if (len > 0 && len < 220) m.set(a, { keep: true, category: 'news' });
    else m.set(a, { keep: true });
  });
  return Promise.resolve(m);
}

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'data', 'official-sources.json');
const FEED_FILE = path.join(ROOT, 'data', 'official-feed.json');
// 看一看 feed：关注号之外的真·公众号（dest=kan）汇入这里，由前端「看一看」视图读取
const LOOK_FEED_FILE = path.join(ROOT, 'data', 'look-feed.json');
// 看一看体量控制：每个真·号只保留最新几篇，单篇正文截断，避免 feed 文件过大拖垮浏览器加载
const LOOK_KEEP = 3;              // 每号留最新 3 篇，控看一看体量；前端已支持无限滚动，池子大些滚动才不断流
                                  // （不再按字数截断正文——早期 LOOK_MAX_TEXT=6000 会把长文砍成"没说完"）
const LOOK_MAX_TEXT = 6000;       // 已废弃：原先用来截断长文，会造成“没说完”，现不再使用
const HISTORY_FILE = path.join(ROOT, 'data', 'articles-history.json');
// 内容库：持续抓取累积的“仓库”，按文章 URL 去重，并标记是否已展示过。
// 每次抓取把候选全量写入库，构建 feed 时只取“未展示”的文章 —— 这就是“显示过的不显示”。
// CI 上把库提交回仓库即可实现“在 GitHub 上持续不间断地抓、存到库里”。
const LIBRARY_FILE = path.join(ROOT, 'data', 'library.json');
const LIBRARY_MAX = Number(process.env.LIBRARY_MAX || 2500);   // 库容量上限，超出裁剪最旧的已展示文章
const SERVE_KEEP = Number(process.env.SERVE_KEEP || 12);      // 每个账号单次最少展示篇数（不足则回退到最旧已展示）
const RECYCLE_WHEN_EMPTY = !/^(0|false|no)$/i.test(process.env.NORECYCLE || ''); // 未展示耗尽时是否回退重展示
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REQUEST_TIMEOUT = 20000;
const MAX_RESPONSE = 5 * 1024 * 1024;
const CONCURRENCY = 3;
const HOST_GAP = 600; // 同主机最小请求间隔(ms)，避免触发反爬/限流
const MAX_RETRY = 3;
const MAX_BLOCKS = 400;          // 单篇正文块上限（公众号长文可超 60 块，原先 60 会截断"没说完"）
const MAX_TEXT = 200000;          // 单篇正文字数上限（逆向/汇编长文可达 8–15 万字，原 30000/80000 都会拦腰截断）
const MIN_BLOCKS = 5;
const HISTORY_LIMIT = 80;
const MIN_COMMENTS = 6;

// 自托管 RSSHub 基地址：CI 工作流内运行完整 RSSHub 时通过环境变量 RSSHUB_BASE 注入
// （如 http://localhost:1200），生成器会把配置里的公共 RSSHub 主机名改写为该地址，
// 从而消除公共实例的限流与路由缺失，稳定抓取澎湃/知乎/掘金/36氪等源。
const RSSHUB_BASE = (process.env.RSSHUB_BASE || '').replace(/\/+$/, '');
function resolveFeedUrl(url) {
  if (!RSSHUB_BASE) return url;
  return url.replace(/^https?:\/\/(rsshub\.[\w.-]+)(\/|$)/i, (_m, _h, rest) => RSSHUB_BASE + rest);
}

// 公众号内容质量门槛
const MIN_BODY_CHARS = 800;     // 公众号文章最低正文字数（低于直接丢弃）

/* 是否允许"模板合成评论"兜底。默认关闭：留言要么真实抓取、要么由 AI 生成
 * （scripts/ai-comments.js → data/ai-review.json），再也不要在 feed 里塞一批
 * "支持正能量内容"/"已分享给同事"这样篇篇雷同的假留言。
 * 临时需要就设环境变量 ALLOW_SYNTHETIC_COMMENTS=1。 */
const ALLOW_SYNTHETIC_COMMENTS = process.env.ALLOW_SYNTHETIC_COMMENTS === '1';
const IMG_DENSITY = 500;        // 正文每约 500 字铺一张插图
const MAX_CONTENT_IMGS = 8;     // 单篇文章最多插图数
const MIN_TEXT_BLOCKS_BETWEEN_IMGS = 2; // 相邻插图之间至少隔 2 个文字块

// 中老年男性向的 topic 白名单
const TOPIC_WHITE = {
  news: ['时政', '民生', '社会', '政策'],
  finance: ['财经', '股市', '基金', '房产', '物价', '养老金', '银行', '存款', '黄金'],
  auto: ['汽车', '油价', '电动车', 'SUV', '保养', '驾驶', '交通'],
  health: ['养生', '健康', '血压', '血糖', '心脏', '颈椎', '睡眠', '运动', '食疗'],
  society: ['社会', '民生', '奇闻', '真相', '揭秘', '维权'],
  life: ['生活', '家电', '数码', '手机', '实用'],
  tech: ['科技', '手机', '数码', '汽车'],
  business: ['商业', '消费', '品牌', '理财', '经济'],
  global: ['全球', '美联储', '美元', '港股', '原油', '通胀']
};

/* ---------- 基础工具 ---------- */

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function decode(value) { return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/gi, ' ').replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/&#(\d+);/g, (_, x) => String.fromCharCode(Number(x))); }
/* 已知 HTML 标签名白名单。二次清理只用它剥标签，不用通用 /<[^>]+>/：
   因为解码后技术文章里的代码示例（<?xml ...?>、<!DOCTYPE ...>、SQL 里的尖括号）会变成
   “像标签的东西”，通用正则会误伤，白名单则不会。 */
const HTML_TAG_RE = /<\/?(?:p|div|span|img|br|a|strong|b|em|i|u|s|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|caption|h[1-6]|figure|figcaption|section|article|aside|header|footer|nav|main|font|center|blockquote|pre|code|small|big|sub|sup|hr|video|audio|source|picture|iframe|input|button|form|label|select|option|textarea|svg|path|g|rect|circle|use|style|script)\b[^>]*>/gi;

/* HTML 转义实体（&lt;p&gt; 这种）解码后会变成真标签，需要再剥一次 */
function stripEscapedTags(text) { return String(text || '').replace(HTML_TAG_RE, ' '); }
function looksLikeHtmlRemainder(text) { HTML_TAG_RE.lastIndex = 0; return HTML_TAG_RE.test(String(text || '')); }

function clean(value) {
  const s = decode(String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' '));
  // 二次清理：处理“被转义过的 HTML”（RSS 里常见的 &lt;p data-vmark="..."&gt; 残留）
  return stripEscapedTags(s).replace(/[ \t\r]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function tag(xml, name) { const m = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); return m ? decode(m[1]).trim() : ''; }
function tagRaw(xml, name) { const m = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); return m ? m[1] : ''; }
function attr(xml, name, key) { const m = String(xml).match(new RegExp(`<${name}\\b([^>]*)>`, 'i')); if (!m) return ''; const a = m[1].match(new RegExp(`${key}=["']([^"']+)["']`, 'i')); return a ? decode(a[1]) : ''; }
function blocks(xml, name) { return String(xml).match(new RegExp(`<${name}\\b[\\s\\S]*?<\\/${name}>`, 'gi')) || []; }
function absolute(value, base) {
  const v = String(value == null ? '' : value).trim();
  if (!v || /^data:/i.test(v)) return '';
  try { return new URL(v, base).href; } catch (_) { return v || ''; }
}
function toHttps(u) {
  if (typeof u !== 'string') return u;
  /* wechat2rss 的 img-proxy 代理已停用（直连 403），真实图地址藏在 ?u=<编码> 里，解开回真实 CDN */
  if (/img-proxy/i.test(u)) {
    const m = u.match(/[?&]u=([^&]+)/);
    if (m) { try { const d = decodeURIComponent(m[1]); if (/^https?:\/\//i.test(d)) return d; } catch (e) { /* ignore */ } }
  }
  return /^http:\/\//i.test(u) ? u.replace(/^http:\/\//i, 'https://') : u;
}
function dateValue(value) { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : 0; }
function dateText(ts) { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; }
function id(value) { let h = 5381; for (const c of String(value)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return String(h); }
function hash32(value) { let h = 2166136261; for (const c of String(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function pickWith(rand, list) { return list[Math.floor(rand() * list.length) % list.length]; }

/* ---------- HTTP（含同主机节流 + 失败重试，保证多源稳定抓取） ---------- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hostLastReq = new Map();

async function throttleHost(host, gap) {
  const gapMs = (typeof gap === 'number' && gap >= 0) ? gap : HOST_GAP;
  const last = hostLastReq.get(host) || 0;
  const wait = last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  hostLastReq.set(host, Date.now());
}

function rawRequest(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target; try { target = new URL(url); } catch (e) { reject(e); return; }
    const client = target.protocol === 'http:' ? http : https;
    const req = client.get(target, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate', Accept: 'text/html,application/xml,application/rss+xml,application/atom+xml,*/*' }, timeout: REQUEST_TIMEOUT }, res => {
      if (res.headers.location && res.statusCode >= 300 && res.statusCode < 400 && redirects < 4) { res.resume(); resolve(rawRequest(absolute(res.headers.location, url), redirects + 1)); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) { req.destroy(new Error('response too large')); return; } chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (_) { /* 解压失败则按原文处理 */ }
        resolve(buf.toString('utf8').replace(/^\uFEFF/, ''));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

async function request(url, redirects = 0, gap) {
  let host = '';
  try { host = new URL(url).host; } catch (_) { /* ignore */ }
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    await throttleHost(host, gap);
    try {
      return await rawRequest(url, redirects);
    } catch (e) {
      lastErr = e;
      // 仅对可重试错误（限流/超时/网络/5xx）退避重试；404 等硬错误直接失败
      const retryable = /429|timeout|ECONN|ENOTFOUND|getaddrinfo|socket|disconnected|HTTP 5/.test(e.message);
      if (retryable && attempt < MAX_RETRY - 1) { await sleep(500 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function mapLimit(items, worker) {
  const out = []; let next = 0;
  async function run() { while (next < items.length) { const i = next++; try { const value = await worker(items[i], i); if (value) out.push(value); } catch (e) { console.warn(`skip: ${items[i].url} (${e.message})`); } } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run)); return out;
}

/* ---------- 题材检测与过滤 ---------- */

function detectTopics(title, summary, keywords) {
  const topics = new Set();
  const text = (title + ' ' + summary).toLowerCase();
  for (const [topic, words] of Object.entries(TOPIC_WHITE)) {
    if (words.some(w => text.includes(w.toLowerCase()))) {
      topics.add(topic);
    }
  }
  // 源配置的关键词匹配
  if (keywords) {
    keywords.forEach(k => {
      if (text.includes(k.toLowerCase())) topics.add('life');
    });
  }
  return topics.size > 0 ? Array.from(topics) : ['life'];
}

function shouldKeep(article, source) {
  // 负面/不适宜内容过滤
  const negative = ['色情', '赌博', '暴力', '毒品', '迷信', '假药', '诈骗'];
  const text = (article.title + ' ' + article.summary).toLowerCase();
  return !negative.some(w => text.includes(w));
}

/* ---------- RSS 发现 ---------- */

/* 频道/列表页链接：中新网等 RSS 里会混入形如 /scroll-news/news1.html 的目录页，
   抓下来没有正文，只会白跑一次请求再被 minChars 淘汰，提前过滤掉。
   只匹配以 .html/.htm 结尾且文件名是 news/index/list/more/page（可带数字）的地址，
   或以 / 结尾的站点首页 —— 不会误伤 /news/123456 这类文章页。 */
function isListPageUrl(url) {
  const p = String(url || '').split(/[?#]/)[0];
  if (!p) return false;
  return /\/(?:news|index|list|more|page)\d*\.html?$/i.test(p) || /\/$/.test(p);
}

function parseDiscovery(xml, source) {
  const atom = /<feed\b/i.test(xml);
  return blocks(xml, atom ? 'entry' : 'item').map(block => {
    const title = clean(tag(block, 'title')); if (!title) return null;
    const url = absolute(atom ? (attr(block, 'link', 'href') || tag(block, 'link')) : (tag(block, 'link') || tag(block, 'guid')), source.siteUrl || source.feedUrl);
    const raw = tagRaw(block, 'content:encoded') || tagRaw(block, 'description') || tagRaw(block, 'summary') || tagRaw(block, 'content');
    const ts = dateValue(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'));
    const image = (raw.match(/<img[^>]+src=["']([^"']+)/i) || [])[1] || '';
    const author = clean(tag(block, 'dc:creator') || (atom ? tag(block, 'name') : '')).slice(0, 24);
    return { id: id(url || title), title, url, summary: clean(raw).slice(0, 260), rssContent: raw, rssCover: absolute(image, url || source.siteUrl || source.feedUrl), rssAuthor: author, ts, topics: detectTopics(title, clean(raw).slice(0, 200), source.keywords) };
  }).filter(Boolean).filter(it => !isListPageUrl(it.url));
}

/* ---------- 新浪实时列表解析 ---------- */

// 新浪官方 RSS（rss.sina.com.cn）早已停止更新：实测 news/china/focus15.xml 停留在
// 2018 年、finance/rollnews.xml 甚至停留在 2008 年，抓到的全是多年旧闻，不可用。
// 因此改用新浪滚动新闻的实时接口 feed.sina.com.cn/api/roll/get（返回 JSON，含当天新闻）：
//   pageid=153&lid=<频道>&num=<条数>&page=<页码>
// 主要字段：title / url / intro / img.u / media_name / ctime(Unix 秒)
function parseSinaJson(text, source) {
  let list = null;
  try {
    const obj = JSON.parse(String(text || ''));
    const data = obj && obj.result ? obj.result.data : null;
    list = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : null);
  } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const base = source.siteUrl || source.feedUrl;
  return list.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const title = clean(entry.title || entry.stitle || '');
    if (!title) return null;
    const url = toHttps(absolute(entry.url || entry.wapurl || '', base));
    if (!url) return null;
    const summary = clean(entry.intro || entry.summary || entry.wapsummary || '').slice(0, 260);
    const img = (entry.img && entry.img.u) || '';
    const ts = Number(entry.ctime || entry.intime || 0) > 0 ? Number(entry.ctime || entry.intime) * 1000 : 0;
    return {
      id: id(url || title),
      title,
      url,
      summary,
      rssContent: '',                                    // 接口无正文，交给文章页抓取
      rssCover: absolute(img, url || base),
      rssAuthor: clean(entry.media_name || entry.author || '').slice(0, 24),
      ts,
      topics: detectTopics(title, summary || title, source.keywords)
    };
  }).filter(Boolean);
}

/* ---------- 网易 JSONP 列表解析 ---------- */

// 网易官方 RSS 已全部下线（news.163.com/rss 等均返回 404），因此改用其自有的
// JSONP 列表接口取标题/链接，正文仍走通用的文章页抓取（pageArticle）。
// 支持两种包装形式：
//   1) data_callback([...])      频道专题页，如 tech.163.com 的 *_datalist.js
//      字段：title / docurl / time(MM/DD/YYYY HH:mm:ss) / imgurl / label
//   2) artiList({"栏目ID":[...]})  移动端 3g 列表接口
//      字段：title / url / digest / imgsrc / ptime(YYYY-MM-DD HH:mm:ss) / source
// 返回值结构与 parseDiscovery 保持一致，后续流程无需区分来源。
function neteaseTime(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  // MM/DD/YYYY HH:mm:ss -> ISO，避免依赖运行环境的美式日期解析
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[\sT](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return dateValue(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6] || '00'}`);
  return dateValue(s.replace(/\//g, '-'));
}

function parseNeteaseJson(text, source) {
  const raw = String(text || '').trim();
  let list = null;
  const dc = raw.match(/^data_callback\(([\s\S]*)\)\s*;?\s*$/);
  const al = raw.match(/^artiList\(([\s\S]*)\)\s*;?\s*$/);
  try {
    if (dc) list = JSON.parse(dc[1]);
    else if (al) {
      // artiList 形如 { 栏目ID: [条目...] }，取第一个非空数组
      const obj = JSON.parse(al[1]);
      list = Object.keys(obj).map(k => obj[k]).find(v => Array.isArray(v) && v.length) || [];
    } else {
      const s = raw.indexOf('[');
      const e = raw.lastIndexOf(']');
      if (s >= 0 && e > s) list = JSON.parse(raw.slice(s, e + 1));
    }
  } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const base = source.siteUrl || source.feedUrl;
  return list.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const title = clean(entry.title || entry.name || '');
    if (!title) return null;
    const url = toHttps(absolute(entry.docurl || entry.url || entry.link || '', base));
    if (!url) return null;
    const summary = clean(entry.digest || entry.summary || entry.description || '').slice(0, 260);
    const img = entry.imgsrc || entry.imgurl || '';
    return {
      id: id(url || title),
      title,
      url,
      summary,
      rssContent: '',                                    // JSONP 无正文，交给文章页抓取
      rssCover: absolute(img, url || base),
      rssAuthor: clean(entry.source || entry.label || '').slice(0, 24),
      ts: neteaseTime(entry.ptime || entry.time || entry.pubDate),
      topics: detectTopics(title, summary || title, source.keywords)
    };
  }).filter(Boolean);
}

/* ---------- 正文结构化解析 ---------- */

const JUNK_RE = /^(相关阅读|推荐阅读|延伸阅读|参考资料|参考文献|免责声明|版权声明|转载须知|广告|关注我们|点击这里|点击查看|查看原文|阅读原文|分享到|分享至|点赞|收藏|举报|投诉|反馈|登录|注册|返回顶部|top|end|完|首页|上一页|下一页|发表评论|加载更多|更多相关|相关文章|猜你喜欢|热门文章|大家都在看|版权所有|全部评论| APP |下载 app)[:：。.!！\s]*$/i;

// 正文尾部署名 / 版权 / 导流信息，应从正文剥离（直接改善"质量差"的观感）
/* 2026-10-09 AI 审核补充："广告声明" —— IT之家每篇文末固定挂一段
 * "广告声明：文内含有的对外跳转链接（包括不限于超链接、二维码、口令等形式）…"
 * 是站点模板免责声明（非正文），既不匹配"免责声明"也不匹配 PROMO_HARD，会漏到正文尾部。 */
const FOOTER_HARD = /(责任编辑|责\s*编|版权所有|阅读下一篇|阅读全文|返回首页|扫描二维码|免责声明|广告声明|举报此|下载客户端|下载APP|点此进入|扫码关注|关注我们|新媒体排版|本文(来源|记者)|稿件来源)/i;
/* 关注引导 / 推广导流文案（AI 审核发现钛媒体"更多精彩内容，关注钛媒体微信号（ID：taimeiti），
 * 或者下载钛媒体App"、新浪财经"炒股就看 金麒麟分析师研报"会漏网残留正文，故补充）。
 * 2026-10-08 批次又发现三种新变体漏网，一并补充：
 *   - 新浪财经"A股公告避雷针"正文首行"登录新浪财经APP 搜索【信披】查看更多考评等级"
 *   - 汇通财经摘要口号"全球汇率新浪最全炒汇神器"
 *   - 爱范儿文末"#欢迎关注爱范儿官方微信公众号：爱范儿（微信号：ifanr），更多精彩内容第一时间为您奉上"
 *     （"关注…微信公众号"中间带"官方公众"，且"更多精彩内容"后无逗号直接接"第一时间"，旧式均匹配不到）
 * 这些是纯文字段落，URL 与图注均无 qr/weixin 特征，只能靠文案关键词拦。 */
const PROMO_HARD = /(更多精彩(内容)?[，,、]?\s*关注|更多精彩内容|关注[^，。；:：]{0,8}微信号|关注\S{0,12}微信公众号|公众号[：:][^，。\n]{0,25}微信号|下载\S{0,8}app|登录\S{0,10}APP|炒股就看|炒汇神器|扫码下载|加入社群|领取福利|专属客服)/i;
function isFooterOrPromo(text) { return FOOTER_HARD.test(text) || PROMO_HARD.test(text); }

// 广告相关内容过滤
const AD_KEYWORDS = ['广告', '赞助', '推广', '营销', '合作', '品牌合作', '软文', '广告图', '商业合作'];
const AD_IMG_PATTERNS = [
  // 不能写成 /ad[._-]?/：量词可选会让它在任意位置匹配 "ad" 两个字母，
  // 于是任何含 ad 子串的正常图片（钛媒体哈希图 ...b3924ad357b383.jpg 就是这么被误杀的）
  // 都会被判成广告图，整篇配图全丢。ad 必须是独立词：紧跟在 / = 之后（/ad/、/ads/、/ad_）。
  /(?:^|[/=])ad[s]?[/._-]/i,
  /sponsor/, /banner[._-]?(img|image)?/, /cpc|cpm|ctr/, /tracking\.png/, /pixel\.gif/, /beacon/i, /analytics/i, /heatmap/i
];
const BAD_DOMAINS = /adserving|adserver|analytics|tracking|beacon|log\.js|stat/i;

function stripNoise(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|nav|header|footer|aside|form|iframe|svg|button|select)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(div|section)[^>]*class=["'][^"']*(?:ad|ads|advertisement|sponsor|banner|sidebar|footer|comment|related|recommend|share)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/gi, ' ')
    .replace(/<(script|style|noscript|br|hr)\b[^>]*\/?>/gi, ' ');
}

function extractMainContent(html) {
  // 优先提取 main 或 article 标签
  const patterns = [
    /<article\b[^>]*>([\s\S]*)<\/article>/i,
    /<main\b[^>]*>([\s\S]*)<\/main>/i,
    // 新浪正文容器：<div class="article" id="artibody">，正文内常嵌图片 div，
    // 故结束边界放宽到文末的互动/评论区或 </body>，不能只用 </div> 否则会过早截断
    /<div\b[^>]+id=["']artibody["'][^>]*>([\s\S]*?)(?:<\/body|<div\b[^>]+class=["'][^"']*(?:article-bottom|post_comment|comment|share|related))/i,
    // 网易正文容器：<div class="post_body">
    // 注意：post_body 内部有多层嵌套 div，用 </div> 做结束边界会在第一个嵌套层就截断（丢正文也丢图），
    // 故结束边界放宽到文末的声明区/评论区或 </body>
    /<div\b[^>]+class=["'][^"']*post_body[^"']*["'][^>]*>([\s\S]*?)(?:<\/body|<div\b[^>]+class=["'][^"']*(?:post_statement|post_comment|comment|share|related))/i,
    // 中新网正文容器：<div class="left_zw">
    // 同样不能用 </div> 做结束边界——正文中常嵌 <div class="left_ph">(配图) 等嵌套层，
    // 会像网易 post_body 那样在第一层就截断。结束边界取文末的编辑/声明/分享区或 </body>。
    /<div\b[^>]+class=["'][^"']*left_zw[^"']*["'][^>]*>([\s\S]*?)(?:<\/body|<div\b[^>]+class=["'][^"']*(?:left_bq|editor|bq|statement|share|comment|related|fenxiang|tuiguang|pageturn))/i,
    // 正文容器，要求后面有明确的结束边界
    // 注意 post_content（下划线，IT之家用的就是它）与 post-content（连字符）都要覆盖，
    // 少一种就会漏掉整个站点，只能靠"最大 div"兜底，正文质量明显变差
    /<div\b[^>]+class=["'][^"']*(?:article-content|article-body|article__content|post-content|post_content|entry-content|rich-text|rich_media_content|markdown-body|content-detail|article-detail|main-content|detail-content|story-content|text-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|<div\b[^>]+class=["'][^"']*(?:comment|sidebar|footer|related|recommend|share|nav))/i,
    // 新闻页面常见结构
    /<div\b[^>]+class=["'][^"']*(?:news_content|newsBody|article_body|content_area)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].length > 800) return m[1];
  }
  
  // 如果都没匹配到，尝试取 body 中最大的 div
  const divMatches = html.match(/<div[^>]*>([\s\S]*?)<\/div>/gi) || [];
  let largestDiv = '';
  for (const div of divMatches) {
    if (div.length > largestDiv.length && div.length > 800) {
      largestDiv = div;
    }
  }
  if (largestDiv) return cleanLargestDiv(largestDiv);
  
  return html;
}

function cleanLargestDiv(div) {
  // 移除 div 中的 header/footer/sidebar
  return div
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
}

// 懒加载占位图：IT之家等站把 src 写成 1x1 占位图（//img.ithome.com/images/v2/t.png），
// 真实图放在 data-src。此时不能按 "src 优先" 取，否则整篇只剩占位图、配图数为 0。
const PLACEHOLDER_IMG = /(?:^|\/)t\.png|placeholder|loading|blank|default|1x1|spacer|grey\.gif|lazy|nosrc/i;

function imgFromAttrs(attrs) {
  const get = k => { const m = attrs.match(new RegExp(`${k}\\s*=\\s*["']([^"']+)["']`, 'i')); return m ? m[1].replace(/&amp;/g, '&') : ''; };
  const src = get('src');
  const lazy = get('data-src') || get('data-original') || get('data-lazy-src') || get('data-echo') || get('data-img') || get('data-lazyload') || get('data-url');
  if (lazy && (!src || PLACEHOLDER_IMG.test(src))) return lazy;
  return src || lazy;
}

// 二维码 / 关注码 / 订阅码 识别（修复华尔街见闻等订阅二维码误入正文）
/* OpenCV 实测为二维码的图片清单（scripts/detect-qr-images.py 生成）。
 * 这些图的 URL 完全正常（新浪/钛媒体的正文域名、扩展名是 .png/.jpg），
 * URL 关键词和上下文都识别不出来，只能靠图片内容检测兜住。 */
function loadQrBlacklist() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'qr-blacklist.json'), 'utf8'));
    return new Set((j.urls || []).map(u => String(u).trim()).filter(Boolean));
  } catch (_) { return new Set(); }
}
const QR_IMAGE_BLACKLIST = loadQrBlacklist();

const QR_RE = /qr|qrcode|weixin|mp\.weixin|scan|subscribe|关注|扫码|公众号|微信号|长按识别|二维码/i;
const SUBSCRIBE_CAPTION_RE = /关注|扫码|订阅|公众号|长按识别|微信号|二维码|加微信|二维码/i;
/* 二维码/关注码的“上下文”关键词：公众号/订阅号二维码几乎总伴随“长按识别二维码关注我们”
 * 这类文字，而普通正文配图不会。用它判断最稳——因为微信/新浪二维码图与正文图同域名
 * （mmbiz.qpic.cn / n.sinaimg.cn），URL 里不含 qr/weixin，纯 URL 检测必漏。 */
const QR_CONTEXT_RE = /二维码|扫码|长按识别|扫描二维码|识别二维码|关注我们|扫码关注|关注公众号|关注后|微信号|加微信|微信扫一扫|点击上方(蓝色)?(字体)?(关注|订阅)/i;
function isQrContext(text) { return QR_CONTEXT_RE.test(String(text || '')); }

function isQrLike(src, attrs, caption) {
  const s = String(src || '').toLowerCase();
  if (QR_RE.test(s)) return true;
  let host = '';
  try { host = new URL(src).host.toLowerCase(); } catch (_) { /* ignore */ }
  if (host.includes('weixin.qq.com') || host.includes('mp.weixin')) return true;
  if (caption && SUBSCRIBE_CAPTION_RE.test(caption)) return true;
  return false;
}

/* 动图（GIF/APNG）识别——公众号正文里的动画绝大多数是装饰或广告：
 * 文末“爱心乱跳/鼓掌/撒花”、分隔线动画、关注引导动画等，既不是新闻配图，也会被读者当成广告。
 * 难点是走 wechat2rss 图片代理后 URL 后缀被吃掉了，只剩两类痕迹：
 *   1) 路径里的 mmbiz_gif / sz_mmbiz_gif（微信 GIF 图床专用目录）
 *   2) 参数里的 wx_fmt=gif（原始写法）或 wx_fmt%3Dgif（被代理二次 URL 编码）
 * 另外微信自带的 we-emoji 表情素材也是纯装饰，一并拦掉。 */
function urlVariants(src) {
  const raw = String(src || '');
  const out = [raw.toLowerCase()];
  try { out.push(decodeURIComponent(raw).toLowerCase()); } catch (_) { /* ignore */ }
  try { out.push(decodeURIComponent(out[1]).toLowerCase()); } catch (_) { /* ignore */ } // 代理会二层编码
  return out;
}
/* 2026-10-08 AI 审核实测：网易图片代理 URL 形如 nimg.ws.126.net/?url=...itm.gif&thumbnail=...
 * ".gif" 后面跟的是 "&" 而非 "?"/行尾，旧式 /\.gif(\?|#|$)/ 漏判，
 * 2026-10-08 批次 GPT-6 一文两张界面演示动图就这样混进了正文。补 "&"。 */
const GIF_RE = /\.gif(\?|#|&|$)|(sz_)?mmbiz_gif|[?&]wx_fmt=gif|res\.wx\.qq\.com\/t\/wx_fed\/we-emoji/i;
function isAnimated(src) {
  return urlVariants(src).some(v => GIF_RE.test(v));
}

function badImage(src, attrs, caption) {
  if (!src || /^data:/i.test(src) || src.length < 12) return true;
  if (QR_IMAGE_BLACKLIST.has(String(src).trim())) return true; // OpenCV 实测二维码（data/qr-blacklist.json）
  if (isAnimated(src)) return true;                            // 动图：装饰/关注引导/广告动效
  const s = src.toLowerCase();
  const basename = src.split('/').pop().toLowerCase();

  // 二维码 / 关注码 / 订阅码（核心修复）
  if (isQrLike(src, attrs, caption)) return true;

  // SVG / 小 png 占位 / 动图表情
  if (/\.svg(\?|$)/i.test(s) || /\/t\.png($|\?)/i.test(s)) return true;
  if (/\.gif(\?|$)/i.test(s)) return true;
  // WordPress 核心表情图（s.w.org/images/core/emoji，AI 审核发现爱范儿 RSS 一次混入 8 张），
  // 与微信 we-emoji 同属纯装饰，文件名是十六进制码点（如 1f9e0.png），只能按路径拦
  if (/s\.w\.org\/images\/core\/emoji/i.test(s)) return true;

  // 钛媒体 RSS 页脚固定模板图：Logo + App 下载二维码（2026-10-08 实测 /2023/tkrss/*.png）
  if (/\/tkrss\//i.test(s)) return true;

  /* 爱范儿早报的栏目分隔模板图（2026-10-09 AI 审核发现，实图核验）：
   * s3.ifanr.com/images/ep/common-images/xin_wen.png     → "今天得先看的重要新闻 / MUST READ"
   * s3.ifanr.com/images/ep/common-images/da_gong_si.png   → "影响我们生活的大公司们 / THE BIG SHOTS"
   * 既不是二维码也不是广告，但属于纯模板装饰图（零信息量），且早报正文里会插在段落之间、
   * 甚至被选为整篇封面，属于明显的观感噪音，按同一 badImage 规则拦掉。 */
  if (/\/images\/ep\/common-images\//i.test(s)) return true;

  // logo / 图标 / 头像类
  if (/logo|icon|avatar|sprite|spacer|pixel|tracking|badge|blank|loading|placeholder|default[_-]?(img|image|cover)?\./i.test(s) || /logo[\w-]*\.(png|jpg|svg)/i.test(basename)) return true;

  // 页面顶部 logo / 站点装饰图（如人民网 topb.png、peopleindex 装饰条）
  if (/topb|top[_-]?banner|sitebanner|peopleindex\/img/i.test(s)) return true;

  // 站点默认图 / 分享小图标 / App 素材图（人民网 rmwapp-prod 默认封面、renren.png 等）
  if (/rmwapp-prod|renren|\/img\/2010wb|people\.com\.cn\/img\//i.test(s)) return true;

  // 广告图 / 追踪图
  if (AD_IMG_PATTERNS.some(p => p.test(s))) return true;
  if (BAD_DOMAINS.test(s)) return true;
  if (s.includes('/ad/') || s.includes('/ads/')) return true;

  // 尺寸过滤
  const w = Number((attrs.match(/width\s*=\s*["']?(\d+)/i) || [])[1]);
  const h = Number((attrs.match(/height\s*=\s*["']?(\d+)/i) || [])[1]);
  if (w && w < 100) return true;
  if (h && h < 80) return true;
  if (w && w > 2000) return true;
  if (h && h > 2000) return true;

  // 小方图（图标 / 二维码）：接近正方形且边长偏小
  if (w && h) {
    const max = Math.max(w, h), min = Math.min(w, h);
    if (max < 400 && (max - min) <= max * 0.08) return true;
  }

  return false;
}

function hasAdContent(html) {
  // 检测页面是否为广告页/跳转页。
  // 注意：正则必须带 g 标志，否则 match() 只返回首个匹配、计数恒为 1，
  // 会让任何含 "ad" 子串（如 read/load/header）的正常新闻页都被误判成广告页。
  // 同时 "ad" 只在 class/id 属性里出现时才计入，避免误伤正文里的普通英文单词。
  const adCount =
    (html.match(/广告|推广|赞助|营销|marketing|sponsor/gi) || []).length +
    (html.match(/class=["'][^"']*\b(?:ad|ads|advert|advertise)\b[^"']*["']/gi) || []).length +
    (html.match(/id=["'][^"']*\b(?:ad|ads|advert)\b[^"']*["']/gi) || []).length;
  const contentCount = (html.match(/<p[ >]|<div[ >]|<section[ >]/gi) || []).length;
  // 如果广告标记占比超过 30%，认为是广告页
  return adCount > contentCount * 0.3;
}

function stripQuery(u) { return String(u || '').split('?')[0].split('#')[0]; }

/* 图片去重 key。
   注意：不能一律按"去掉查询参数的 path"去重——网易等站用图片代理/CDN 网关，
   真实图址藏在查询参数里（如 https://nimg.ws.126.net/?url=http%3A%2F%2F...jpg&thumbnail=...），
   去掉 ? 之后所有图的 key 都变成同一个空 path，整篇配图会被判成重复而只剩 1 张。
   规则：path 里已带图片扩展名才按 path 去重，否则用完整 URL（含查询参数）去重。 */
function imgDedupKey(u) {
  const s = String(u || '');
  const noHash = s.split('#')[0];
  const path = noHash.split('?')[0];
  return /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(path) ? path : noHash;
}

function contentBlocks(html, base) {
  const out = [];
  let textLen = 0;
  let imgCount = 0;
  let lastText = '';   // 上一段正文文字，用于上下文判断二维码（公众号二维码总伴随“长按识别二维码”等文字）
  const MAX_IMGS = 15;
  
  // 检测并截断分隔符之后的内容（如"生活新闻精选："、"延伸阅读"等）
  const TRUNCATION_MARKERS = [
    /[:：]\s*生活新闻精选\s*[:：]?\s*$/i,
    /[:：]\s*延伸阅读\s*[:：]?/i,
    /[:：]\s*相关阅读\s*[:：]?/i,
    /[:：]\s*推荐阅读\s*[:：]?/i,
    /^[\s]*$/,  // 空行
    /^[\s]*[\-—_—≈≈]{3,}[\s]*$/  // 分隔线
  ];
  
  function shouldTruncate(text) {
    return TRUNCATION_MARKERS.some(re => re.test(text));
  }
  
  // 是不是公众号/订阅号的二维码图：URL 命中 isQrLike，或图注/上下文文字命中二维码关键词
  function isQrImg(src, attrs, caption) {
    if (isQrLike(src, attrs, caption)) return true;
    if (isQrContext(caption) || isQrContext(lastText)) return true;
    return false;
  }
  
  function pushImg(attrs, caption) {
    if (imgCount >= MAX_IMGS) return;
    const src = absolute(imgFromAttrs(attrs), base);
    if (badImage(src, attrs, caption)) return;
    if (isQrImg(src, attrs, caption)) return;   // 跳过“长按识别二维码关注”这类关注码，不进正文也不当封面
    const last = out[out.length - 1];
    if (last && last.type === 'img' && imgDedupKey(last.src) === imgDedupKey(src)) return;
    out.push({ type: 'img', src, caption: caption || '' });
    imgCount++;
  }
  
  function pushText(kind, raw) {
    const text = clean(raw);
    if (!text || text.length < 2) return;
    if (JUNK_RE.test(text)) return;
    if (isFooterOrPromo(text)) return;
    // 检查是否到达文章结尾标记。
    // 同样不能用"含完字"判断：正文里的"完成/完美/完工"会误触发停止，导致整篇只剩开头几段。
    // 只有整段恰好是"完"时才认为到文末。
    if (text.trim() === '完' || text.includes('生活新闻精选') ||
        text.includes('延伸阅读') || text.includes('相关阅读') || text.includes('推荐阅读')) {
      return; // 停止添加后续内容
    }
    if (textLen + text.length > MAX_TEXT) return;
    textLen += text.length;
    lastText = text;   // 记录最近一段正文，供后续图片做二维码上下文判定
    out.push({ type: kind, text });
  }
  
  const src = stripNoise(html);
  const re = /<(h[1-6]|p|blockquote|pre|figure)\b([^>]*)>([\s\S]*?)<\/\1>|<img\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(src)) && out.length < MAX_BLOCKS) {
    if (m[4] !== undefined) { pushImg(m[4], ''); continue; }
    const tagname = m[1].toLowerCase(), inner = m[3] || '';
    if (tagname === 'figure') {
      const img = inner.match(/<img\b([^>]*?)\/?>/i);
      const cap = clean((inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1]);
      if (img && !isQrContext(cap)) pushImg(img[1], cap.slice(0, 80));
      else if (img) { /* 图注是二维码关键词：跳过该关注码 */ }
      else pushText('p', inner);
      continue;
    }
    const img = inner.match(/<img\b([^>]*?)\/?>/i);
    const text = clean(inner);
    // 先记录本段文字作为二维码上下文依据：即便这段被 JUNK/页脚规则丢弃（如"扫码关注公众号"），
    // 它依然是"紧跟其后的那张图是订阅码"的强信号，所以要在过滤前记下。
    if (text && text.length > 1) lastText = text;
    if (img) {
      const cap = (img[1].match(/alt\s*=\s*["']([^"']+)["']/i) || [])[1] || (text.length <= 60 ? text : '');
      // 同一段内文字（如“长按识别二维码关注我们”）或图注含二维码关键词 → 该图是关注码，跳过
      if (!isQrContext(text) && !isQrContext(cap) && !isQrLike(imgFromAttrs(img[1]), img[1], cap)) {
        pushImg(img[1], decode(cap).slice(0, 80));
      }
    }
    if (tagname.startsWith('h')) { 
      if (text && text.length <= 80 && !JUNK_RE.test(text)) { 
        if (textLen + text.length <= MAX_TEXT) { textLen += text.length; out.push({ type: 'h', text }); } 
      } 
      continue; 
    }
    if (tagname === 'blockquote') { pushText('quote', text.slice(0, 500)); continue; }
    if (text && text !== (out[out.length - 1] || {}).text) pushText('p', text);
  }
  return out;
}

function articleBlocks(html, item) {
  // 先提取主要正文区域，去除页眉页脚侧边栏
  let mainContent = extractMainContent(html);

  // 强力截断：移除"完"或"社会新闻精选"之后的所有内容。
  // 注意："完"必须独立成段才算结束标记，不能用子串匹配——
  // 否则正文里的"完成/完美/完工"等普通用词会把文章拦腰截断，导致整篇被判为无正文。
  const TRUNCATE_RES = [
    /<p[^>]*>\s*完\s*<\/p>/i,
    /社会新闻精选/,
    /生活新闻精选/,
    /延伸阅读/,
    /相关阅读/
  ];
  let truncateIdx = -1;
  for (const re of TRUNCATE_RES) {
    const m = mainContent.match(re);
    if (m && typeof m.index === 'number' && (truncateIdx < 0 || m.index < truncateIdx)) {
      truncateIdx = m.index;
    }
  }
  if (truncateIdx >= 0) {
    mainContent = mainContent.slice(0, truncateIdx);
  }

  // 只剔除广告段落，保留其余全部内容（含 <img>，不能只 join 段落否则丢图）
  let cleanHtml = mainContent;
  const paragraphs = mainContent.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  paragraphs.forEach(p => {
    const hasImg = /<img\b/i.test(p);
    const text = clean(p);
    // 含配图的段落不能因"文本过短"被整段删除：网易/新浪常见 <p><img></p> 写法，
    // 段落文本为空，按短文本清理会把正文配图一起抹掉（网易科技因此长期 0 图）。
    // 配图段落只在明确命中广告词时才删，其余交给后续 badImage 统一过滤。
    if (hasImg) {
      if (AD_KEYWORDS.some(kw => text.includes(kw))) cleanHtml = cleanHtml.replace(p, ' ');
      return;
    }
    // 二维码/关注文案段落要保留在 HTML 里：pushText 会按页脚规则把它剔出正文（不显示），
    // 但它必须留下来为"紧跟其后的那张图"提供"这是订阅码"的上下文信号。
    // 若在这里按"短段落"删掉，后面的二维码图就失去判据、会被当成正文配图保留。
    if (isQrContext(text)) return;
    if (AD_KEYWORDS.some(kw => text.includes(kw)) || text.length <= 20) {
      cleanHtml = cleanHtml.replace(p, ' ');
    }
  });
  
  // 去重后的图片池（全局限制）
  const seenImgUrls = new Set();
  const MAX_TOTAL_IMGS = MAX_CONTENT_IMGS;
  let totalImgCount = 0;
  
  const out = [];
  let textLen = 0;
  let lastText = '';   // 上一段正文，用于上下文判断二维码（公众号二维码总伴随“长按识别二维码”等文字）
  
  function pushImg(src, attrs, caption) {
    if (STOP_PROCESSING) return; // 已经停止处理，跳过后续图片
    if (totalImgCount >= MAX_TOTAL_IMGS) return;
    // 统一走 badImage（含二维码/关注码/广告/图标过滤）
    if (badImage(src, attrs, caption)) return;
    // 上下文二维码过滤：图注或上一段正文含“二维码/扫码/关注我们”等关键词 → 是订阅码，跳过
    if (isQrContext(caption) || isQrContext(lastText) || isQrLike(src, attrs, caption)) return;

    // 去重：使用URL去掉查询参数后比较
    const key = imgDedupKey(src);
    if (seenImgUrls.has(key)) return;
    seenImgUrls.add(key);

    out.push({ type: 'img', src, caption: caption || '' });
    totalImgCount++;
  }
  
  function pushText(kind, raw) {
    if (STOP_PROCESSING) return; // 已经停止处理
    const text = clean(raw);
    if (!text || text.length < 2) return;
    if (JUNK_RE.test(text)) return;
    if (isFooterOrPromo(text)) return;
    // 检查是否到达文章结尾标记。
    // 同样不能用 "含完字" 判断：正文里的"完成/完美"会误触发停止，导致整篇只剩开头几段。
    // 只有整段恰好是"完"时才认为是结尾标记。
    const flat = text.trim();
    if (flat === '完' || text.includes('生活新闻精选') ||
        text.includes('延伸阅读') || text.includes('相关阅读') || text.includes('推荐阅读')) {
      STOP_PROCESSING = true; // 设置停止标志
      return;
    }
    if (textLen + text.length > MAX_TEXT) return;
    textLen += text.length;
    lastText = text;   // 记录最近一段正文，供后续图片做二维码上下文判定
    out.push({ type: kind, text });
  }
  
  const src = stripNoise(cleanHtml);
  let STOP_PROCESSING = false; // 停止处理标志
  const re = /<(h[1-6]|p|blockquote|pre|figure)\b([^>]*)>([\s\S]*?)<\/\1>|<img\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(src)) && out.length < MAX_BLOCKS && !STOP_PROCESSING) {
    if (m[4] !== undefined) { 
      const imgSrc = imgFromAttrs(m[4]);
      pushImg(absolute(imgSrc, item.url), m[4], ''); 
      continue; 
    }
    const tagname = m[1].toLowerCase(), inner = m[3] || '';
    if (tagname === 'figure') {
      const img = inner.match(/<img\b([^>]*?)\/?>/i);
      const cap = clean((inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1]);
      if (img && !isQrContext(cap)) {
        const imgSrc = imgFromAttrs(img[1]);
        pushImg(absolute(imgSrc, item.url), img[1], cap?.slice(0, 80));
      } else if (img) {
        /* 图注命中二维码关键词：是订阅码，跳过 */
      } else {
        pushText('p', inner);
      }
      continue;
    }
    const img = inner.match(/<img\b([^>]*?)\/?>/i);
    const text = clean(inner);
    // 先记录本段文字作为二维码上下文依据：即便这段被 JUNK/页脚规则丢弃（如"扫码关注公众号"），
    // 它依然是"紧跟其后的那张图是订阅码"的强信号，所以要在过滤前记下。
    if (text && text.length > 1) lastText = text;
    if (img) {
      const imgSrc = imgFromAttrs(img[1]);
      const cap = (img[1].match(/alt\s*=\s*["']([^"']+)["']/i) || [])[1] || (text.length <= 60 ? text : '');
      // 同段文字（如“长按识别二维码关注我们”）或图注含二维码关键词 → 该图是关注码，跳过不进正文
      if (!isQrContext(text) && !isQrContext(cap) && !isQrLike(imgSrc, img[1], cap)) {
        pushImg(absolute(imgSrc, item.url), img[1], decode(cap).slice(0, 80));
      }
    }
    if (tagname.startsWith('h')) { 
      if (text && text.length <= 80 && !JUNK_RE.test(text)) { 
        if (textLen + text.length <= MAX_TEXT) { textLen += text.length; out.push({ type: 'h', text }); } 
      } 
      continue; 
    }
    if (tagname === 'blockquote') { pushText('quote', text.slice(0, 500)); continue; }
    if (text && text !== (out[out.length - 1] || {}).text) pushText('p', text);
  }
  
  // 后处理：截断包含标记的文本块之后的所有内容
  const TRUNCATE_MARKS = ['完', '社会新闻精选', '生活新闻精选', '延伸阅读', '相关阅读'];
  for (let i = 0; i < out.length; i++) {
    if (out[i].type === 'p' && out[i].text) {
      const shouldTruncate = TRUNCATE_MARKS.some(m => out[i].text.includes(m));
      if (shouldTruncate) {
        // 只保留包含标记的块，删除后续所有块
        out.splice(i + 1);
        break;
      }
    }
  }
  
  return out;
}

/* ---------- 作者 / meta ---------- */

function metaAll(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) { const m = html.match(re); if (m && m[1]) return decode(m[1]); }
  return '';
}

function validAuthor(name) {
  const v = clean(name).replace(/^(作者|编辑|撰文|撰稿)\s*[：:\/]?\s*/, '');
  if (!v || v.length < 2 || v.length > 20) return '';
  if (/^(佚名|admin|test|unknown|网友|本站|本刊|编辑部|微信|平台|介绍|简介|的话|导读|编者按)$/i.test(v)) return '';
  if (/官方账号|公众号|账号|数字编辑|责任编辑|值班编辑/.test(v)) return '';
  if (/\d{4}-\d{2}-\d{2}/.test(v) || /[\n<>]/.test(v)) return '';
  return v;
}

function cleanTitle(title, source) {
  let t = clean(title);
  const name = (source && source.name) || '';
  for (let i = 0; i < 3; i++) {
    const m = t.match(/\s*[|｜\-–—_]\s*([^\s|｜\-–—_]{2,20})$/);
    if (!m) break;
    const tail = m[1];
    const hit = (name && (name.includes(tail) || tail.includes(name.replace(/周刊|爱好者/g, ''))))
      || /^(ithome|it之家|少数派|sspai|solidot|36氪|澎湃|新浪|网易|腾讯|搜狐|csdn|知乎|简书|博客园|infoq)$/i.test(tail);
    if (hit) t = t.slice(0, m.index).trim(); else break;
  }
  return t || clean(title);
}

function articleAuthor(html, source, item) {
  const candidates = [
    validAuthor(metaAll(html, 'author')),
    validAuthor(metaAll(html, 'article:author')),
    validAuthor(metaAll(html, 'og:article:author')),
    validAuthor((html.match(/(?:作\s*者|撰\s*文|撰稿人|责?任?编辑)\s*[：:\/]\s*(?:<\/?[a-z][^>]*>\s*)*([^\s<>|"，。]{2,20})/) || [])[1]),
    validAuthor(item.rssAuthor),
  ];
  for (const c of candidates) if (c) return c;
  return source.name;
}

/* ---------- 评论：中老年男性风格 ---------- */

const NICKS = ['老张头', 'Mountain Man', '钓鱼佬永不空军', '岁月如歌', '清风明月', '海阔天空', '云淡风轻', '老李聊车', '养生达人', '投资老兵', '老马识途', '高山流水', '松柏常青', '闲云野鹤', '平凡人生', '知足常乐', '往事如烟', '阳光正好', '老陈说事', '铁血丹心'];
const LOCATIONS = ['山东青岛', '北京海淀', '江苏南京', '浙江杭州', '四川成都', '湖北武汉', '广东广州', '湖南长沙', '陕西西安', '河南郑州', '辽宁沈阳', '海外华人'];
const COMMENT_TPL = [
  '写得不错，支持一下', '这个观点我同意', '以前不知道，学到了', '感谢分享，已转发家族群',
  '讲得实在，比那些虚头巴脑的强多了', '年纪大了就要多关注健康', '这种文章应该多写写',
  '收藏了，慢慢看', '支持正能量内容', '转发到朋友圈让更多人看到', '说到了心坎里',
  '实用，下次试试', '感谢博主整理', '期待更多内容', '顶一个', '说得对',
  '家里有老人可以参考', '这种内容才是我们需要的', '已分享给同事', '很有参考价值'
];
const REPLY_TPL = ['确实', '没错', '支持', '学习了', '同感', '赞一个', '说得在理', '已转给老伴看'];

const COMMENT_UI_JUNK = /^(更多|加载|我来说|说点什么|发表评论|查看全部|展开|收起|回复|点赞|分享|举报|登录|注册|评论|排序|热门|最新|沙发|下一页|上一页|推荐|相关|广告)/;

function parsePublicComments(html) {
  const result = [];
  const patterns = [/<(?:div|li|p)[^>]+class=["'][^"']*(?:comment|reply)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li|p)>/gi];
  for (const re of patterns) { let m; while ((m = re.exec(html)) && result.length < 20) { const text = clean(m[1]); if (text.length >= 6 && text.length <= 500 && !JUNK_RE.test(text) && !COMMENT_UI_JUNK.test(text) && !/加载中|请输入|条评论/.test(text)) result.push({ text }); } }
  return result.filter((item, index, list) => list.findIndex(x => x.text === item.text) === index);
}

function commentTimeText(minutesAgo, now) {
  if (minutesAgo < 1) return '刚刚';
  if (minutesAgo < 60) return Math.max(1, Math.round(minutesAgo)) + '分钟前';
  if (minutesAgo < 1440) return Math.floor(minutesAgo / 60) + '小时前';
  if (minutesAgo < 2880) { const d = new Date(now - minutesAgo * 60000); return '昨天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  const d = new Date(now - minutesAgo * 60000);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function buildComments(article, html) {
  // 这里不再从 HTML 里硬抠评论：评论区是 JS 渲染的，硬抠抓到的往往是文章标题、
  // 导航文案、站点名等无关文本（实测会把 "xxx_新浪财经_新浪网" 当成一条评论），质量比模板还差。
  // 真实评论统一由 fetchRealComments() 走各家官方评论接口获取，抓不到才用下面的模板兜底。
  const uniqueComments = [];
  
  const rand = rng(hash32(article.id + 'comments'));
  const now = Date.now();
  const ageHours = Math.max(2, (now - article.ts) / 3600000);
  const target = Math.max(MIN_COMMENTS, uniqueComments.length) + Math.floor(rand() * 5);
  const usedNames = new Set();
  const list = [];
  
  function nextNick() {
    let name = pickWith(rand, NICKS);
    if (usedNames.has(name)) name = name + '_' + Math.floor(rand() * 90 + 10);
    usedNames.add(name);
    return name;
  }
  
  // 优先使用真实评论
  uniqueComments.forEach((c, i) => {
    list.push({
      id: id(article.id + '|real|' + i),
      name: nextNick(),
      location: pickWith(rand, LOCATIONS),
      time: commentTimeText(Math.floor(rand() * ageHours * 60), now),
      avatar: '',
      text: c.text,
      likes: Math.floor(rand() * 200),
      replies: []
    });
  });
  
  // 补充模拟评论
  while (list.length < target) {
    const c = {
      id: id(article.id + '|' + list.length),
      name: nextNick(),
      location: pickWith(rand, LOCATIONS),
      time: commentTimeText(Math.floor(rand() * ageHours * 60), now),
      avatar: '',
      text: pickWith(rand, COMMENT_TPL),
      likes: Math.floor(rand() * rand() * 300),
      replies: [],
    };
    if (rand() < 0.15) {
      const fromAuthor = rand() < 0.5;
      c.replies.push({
        name: fromAuthor ? (article.author || '作者') : nextNick(),
        authorFlag: fromAuthor,
        text: pickWith(rand, REPLY_TPL),
        time: commentTimeText(Math.floor(rand() * 120), now),
      });
    }
    list.push(c);
  }
  return list;
}

/* ---------- 互动数据 ---------- */

function fmtRead(n) { return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n); }

function buildStats(article, commentCount) {
  const h = hash32(article.id + 'stats');
  const read = 8000 + h % 80000;
  return {
    read: fmtRead(read),
    likes: 100 + (h >>> 8) % 5000,
    shares: 50 + (h >>> 16) % 1200,
    favorites: 30 + (h >>> 4) % 900,
  };
}

/* ---------- 文章合成器 ---------- */

const SYNTHETIC_TOPICS = {
  health: [
    { title: '医生提醒：这三种食物越吃血管越堵，中老年人一定要少吃', intro: '血管健康是中老年人健康的根本，饮食习惯直接影响血管状态。今天我们来聊聊那些看似营养、实则伤血管的食物。' },
    { title: '早起后不要做这3件事，很多人每天都在做，难怪身体越来越差', intro: '早起后的习惯对一天的健康影响很大，某些看似无害的行为可能正在悄悄损害你的身体。' },
    { title: '人到中年才明白：最便宜的养生法就是这四点，做到就赚到了', intro: '养生不需要花大钱，坚持好的生活习惯就是最好的投资。' }
  ],
  finance: [
    { title: '养老金又涨了！这3类人群受益最大，看看有你吗？', intro: '近日养老金调整方案发布，不同人群享受的涨幅有所不同。' },
    { title: '存款利率再次下调，手中有存款的人该怎么办？理财师给出建议', intro: '当前存款利率处于历史低位，合理配置资产变得尤为重要。' },
    { title: '金价再创历史新高，普通人该如何参与？这3种方式了解一下', intro: '黄金作为传统避险资产，在动荡时期备受青睐。' }
  ],
  auto: [
    { title: '国产车质量今非昔比，这5款车耐用性实测，值得入手', intro: '近年来国产车进步明显，多款产品在耐用性和配置上已经具备竞争力。' },
    { title: '油价又要调整了，下周预计上涨，加油前做好这几点', intro: '近期国际油价波动较大，国内成品油价格调整即将落地。' },
    { title: '老年人买车注意这3点，安全舒适最重要，别只看配置和外观', intro: '中老年购车应更注重安全性和舒适性，避免冲动消费。' }
  ],
  society: [
    { title: '农村养老新政策落地，这3项福利每人都有，村里人会受益', intro: '农村养老保障体系正在完善，多项福利政策即将实施。' },
    { title: '发现这种情况及时向有关部门反映，涉及每个人的钱袋子', intro: '生活中遇到异常情况要保持警惕，及时反映问题维护自身权益。' },
    { title: '社区食堂开进小区，老年人就餐问题有新解法，你家门口的有吗？', intro: '社区助餐服务正在全国推广，为老年人提供便利的用餐选择。' }
  ]
};

function generateSyntheticArticles(dayOffset = 0) {
  const articles = [];
  const today = new Date();
  today.setDate(today.getDate() - dayOffset);
  today.setHours(8, 0, 0, 0);
  const dayTs = today.getTime();
  const rand = rng(dayTs);
  const topics = Object.keys(SYNTHETIC_TOPICS);
  const selectedTopic = topics[Math.floor(rand() * topics.length)];
  const pool = SYNTHETIC_TOPICS[selectedTopic];
  const item = pool[Math.floor(rand() * pool.length)];
  const now = Date.now();
  const ageHours = Math.max(2, (now - dayTs) / 3600000);

  // 生成评论
  const NICKS_SYNTH = ['老张头', 'Mountain Man', '钓鱼佬永不空军', '岁月如歌', '清风明月', '海阔天空', '云淡风轻', '老李聊车', '养生达人', '投资老兵'];
  const LOCATIONS_SYNTH = ['山东青岛', '北京海淀', '江苏南京', '浙江杭州', '四川成都', '湖北武汉', '广东广州'];
  const COMMENT_TPL_SYNTH = ['写得不错，支持一下', '这个观点我同意', '以前不知道，学到了', '感谢分享，已转发家族群', '年纪大了就要多关注健康', '收藏了，慢慢看'];
  const usedNames = new Set();
  const comments = [];
  for (let i = 0; i < 5; i++) {
    let name = NICKS_SYNTH[i % NICKS_SYNTH.length];
    if (usedNames.has(name)) name = name + '_' + i;
    usedNames.add(name);
    comments.push({
      id: id('synth_c_' + i),
      name,
      location: LOCATIONS_SYNTH[i % LOCATIONS_SYNTH.length],
      time: commentTimeText(Math.floor(rand() * ageHours * 60), now),
      avatar: '',
      text: COMMENT_TPL_SYNTH[i % COMMENT_TPL_SYNTH.length],
      likes: Math.floor(rand() * 100),
      replies: []
    });
  }

  // 生成 stats
  const statsH = hash32(dayTs + 'synth_stats');
  const readCount = 18000 + (statsH % 40000);

  articles.push({
    id: id('synth_' + dayTs + '_' + selectedTopic),
    title: item.title,
    summary: item.intro,
    body: item.intro,
    content: [
      { type: 'p', text: item.intro },
      { type: 'h', text: '具体内容' },
      { type: 'p', text: '这里展示文章的详细正文内容，会结合当天抓取到的真实素材进行润色和重组。' }
    ],
    url: '',
    cover: '',
    ts: dayTs,
    date: dateText(dayTs),
    type: '图文',
    author: '小编',
    sourceName: '中老年生活报',
    accountName: '中老年生活报',
    topics: [selectedTopic],
    isSynthetic: true,
    stats: { read: fmtRead(readCount), likes: 400 + (statsH >>> 8) % 2000, shares: 80 + (statsH >>> 16) % 500, favorites: 50 + (statsH >>> 4) % 300, comments: comments.length },
    read: fmtRead(readCount),
    comments
  });

  return articles;
}

/* ---------- 真实评论抓取（新浪 / 网易） ---------- */
/*
  两家都把评论放在独立接口里，正文 HTML 里抠不到（评论区是 JS 渲染的），
  所以 buildComments() 从 HTML 硬抠基本无效、只能补假数据。这里改为直接打评论接口。

  新浪：先从文章页取 channel + comment_id，再请求
        https://comment.sina.com.cn/page/info?version=1&format=json&channel=<ch>&newsid=<cid>&...
        返回 result.cmntlist[]（nick/content/area/time/agree/profile_img）
  网易：从文章 URL 末段取 docId，请求
        https://comment.api.163.com/api/v1/products/<pk>/threads/<docId>/comments/newList?...&ibc=jssdk
        注意路径必须是 newList / hotList，直接请求 /comments 会返回 400 Bad request。
        返回 { commentIds: [...], comments: { <id>: { content, createTime, vote, user:{nickname,location,avatar} } } }
        commentIds 里有 "a,b" 逗号分隔的楼中楼，需要拆开取。

  抓不到（接口挂了/文章太新还没人评论）时返回空数组，由调用方降级回 buildComments。
*/
const NETEASE_COMMENT_PK = 'a2869674571f77b5a0867c3d71db5856';
const MAX_REAL_COMMENTS = 12;

function commentTimeFrom(dateStr, now) {
  // 新浪 "2026-09-29 11:48:57"、网易 "2026-09-29 09:34:48"，Safari 不认横杠，统一换成斜杠
  const t = Date.parse(String(dateStr || '').trim().replace(/-/g, '/'));
  if (!t || isNaN(t)) return '';
  const mins = (now - t) / 60000;
  if (mins < 1) return '刚刚';
  return commentTimeText(mins, now);
}

let out_counter = 0;
function normalizeComment(c, now) {
  const text = clean(c.text || '');
  if (text.length < 2 || text.length > 300) return null;
  return {
    id: id('c_' + (c.oid || text.slice(0, 8)) + '_' + out_counter++),
    name: clean(c.name || '网友').slice(0, 24),
    location: clean(c.location || '').slice(0, 20),
    time: commentTimeFrom(c.time, now) || commentTimeText(60 + Math.floor(Math.random() * 600), now),
    avatar: toHttps(c.avatar || ''),
    text,
    likes: Number(c.likes) || 0,
    replies: []
  };
}

async function fetchSinaComments(url, html) {
  let page = html || '';
  if (!page) { try { page = await request(url); } catch (_) { return []; } }
  const ch = (page.match(/channel\s*[:=]\s*['"]([a-z]{2})['"]/i) || [])[1];
  const cid = (page.match(/comment_id\s*[:=]\s*['"]([^'"]+)['"]/i) || [])[1]
           || (page.match(/newsid\s*[:=]\s*['"](comos-[^'"]+)['"]/i) || [])[1];
  if (!ch || !cid) return [];
  const api = 'https://comment.sina.com.cn/page/info?version=1&format=json'
    + '&channel=' + encodeURIComponent(ch)
    + '&newsid=' + encodeURIComponent(cid)
    + '&group=0&compress=0&ie=utf-8&oe=utf-8&page=1&page_size=20';
  let raw = '';
  try { raw = await request(api); } catch (_) { return []; }
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { return []; }
  const list = (data && data.result && data.result.cmntlist) || [];
  const now = Date.now();
  const out = [];
  for (const c of list) {
    const n = normalizeComment({
      oid: c.mid, name: c.nick, location: c.area, time: c.time,
      avatar: c.profile_img, text: clean(c.content || ''), likes: c.agree
    }, now);
    if (n) out.push(n);
    if (out.length >= MAX_REAL_COMMENTS) break;
  }
  return out;
}

async function fetchNeteaseComments(url) {
  const doc = (String(url || '').match(/\/([A-Z0-9]{10,20})\.html/i) || [])[1];
  if (!doc) return [];
  const base = 'https://comment.api.163.com/api/v1/products/' + NETEASE_COMMENT_PK
    + '/threads/' + doc + '/comments/';
  const qs = 'offset=0&limit=20&showLevelThreshold=200&headLimit=1&tailLimit=2&ibc=jssdk';
  const now = Date.now();
  const out = [];
  const seen = new Set();
  // 热门优先，再补最新
  for (const path of ['hotList', 'newList']) {
    let raw = '';
    try { raw = await request(base + path + '?' + qs); } catch (_) { continue; }
    let data = null;
    try {
      // 不带 callback 时是纯 JSON；万一服务端仍返回 JSONP 包装则剥掉
      const m = raw.match(/^\s*[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
      data = JSON.parse(m ? m[1] : raw);
    } catch (_) { continue; }
    const map = (data && data.comments) || {};
    const ids = Array.isArray(data.commentIds) ? data.commentIds : Object.keys(map);
    for (const key of ids) {
      for (const oneId of String(key).split(',')) {   // commentIds 里 "a,b" 是楼中楼
        const c = map[String(oneId).trim()];
        if (!c || seen.has(c.commentId)) continue;
        seen.add(c.commentId);
        const u = c.user || {};
        const n = normalizeComment({
          oid: c.commentId, name: u.nickname, location: u.location, time: c.createTime,
          avatar: u.avatar, text: clean(c.content || ''), likes: c.vote
        }, now);
        if (n) out.push(n);
        if (out.length >= MAX_REAL_COMMENTS) return out;
      }
    }
  }
  return out;
}

async function fetchRealComments(article, html) {
  const url = (article && article.url) || '';
  if (!url) return [];
  try {
    if (/163\.com/i.test(url)) return await fetchNeteaseComments(url);
    if (/sina\.com/i.test(url)) return await fetchSinaComments(url, html);
  } catch (_) { /* 评论抓不到不能影响正文入库 */ }
  return [];
}

/* ---------- 文章组装 ---------- */

async function pageArticle(item, source, html) {
  // 过滤广告页面和跳转页
  if (hasAdContent(html)) return null;
  
  const title = cleanTitle(metaAll(html, 'og:title') || tag(html, 'title') || item.title, source);
  const content = articleBlocks(html, item);
  const bodyText = content.filter(b => b.text).map(b => b.text).join('\n\n');

  // 严格检查正文质量：公众号文章必须达到最低正文字数（默认 800），低于直接丢弃
  const minChars = source.minChars || MIN_BODY_CHARS;
  const textLen = bodyText.length;
  const imgCount = content.filter(b => b.type === 'img').length;
  // DEBUG_DROP=1 时打印每条被丢弃的原因（字数不足 / 配图不足），
  // 用于调 minChars、minImgs 门槛 —— 否则"某源 0 篇"只能靠猜。
  if (process.env.DEBUG_DROP) {
    const needImg = Number(source.minImgs) || 0;
    if (textLen < minChars) console.warn(`  DROP-CHARS ${source.name} ${textLen}/${minChars} ${item.url}`);
    else if (imgCount < needImg) console.warn(`  DROP-IMG ${source.name} ${imgCount}/${needImg} chars=${textLen} ${item.url}`);
  }
  if (textLen < minChars) return null;
  // 公众号文章要求最少配图数（source.minImgs，默认 0=不限制）：
  // 纯文字没配图的条目更像快讯而不是公众号图文，配图不足直接丢弃。
  if (imgCount < (Number(source.minImgs) || 0)) return null;
  
  // 封面优先用正文真实配图（已通过 badImage 过滤）；og:image 多为站点 logo/默认图，仅作兜底。
  // 扫描正文【所有】图，若第一张是 logo/二维码被 badImage 跳过，自动顺延到下一张好图，
  // 避免“有图却无封面”（如 网易科技 正文首图是站点装饰、但内文有真图）。
  const contentImgs = content.filter(b => b.type === 'img' && b.src).map(b => b.src);
  const cover = pickCover([...contentImgs, metaAll(html, 'og:image'), item.rssCover], item.url || source.siteUrl);
  const ts = dateValue(metaAll(html, 'article:published_time') || metaAll(html, 'pubdate')) || item.ts || Date.now();
  const author = articleAuthor(html, source, item);
  const article = {
    id: item.id, title, summary: clean(metaAll(html, 'description') || item.summary).slice(0, 200),
    body: bodyText.slice(0, MAX_TEXT), content,
    url: item.url, cover, ts, date: dateText(ts), type: '图文',
    author, sourceName: source.name, accountName: source.name,
    topics: item.topics || ['life'],
  };
  if (!shouldKeep(article, source)) return null;
  article.stats = buildStats(article, 0);
  article.read = article.stats.read;
  // 真实评论优先（新浪/网易评论接口）；抓不到【不再】补模板评论。
  // 模板评论（"支持正能量内容"/"已分享给同事"这类）篇篇雷同、没有信息量，用户明确不要：
  // 留言该由 AI 事后统一生成（scripts/ai-comments.js → data/ai-review.json），
  // 前端拿不到 AI/真实评论时展示「还没有留言」空态，比摆一排假留言体面。
  // 万一临时想恢复，设环境变量 ALLOW_SYNTHETIC_COMMENTS=1 即可。
  const realComments = await fetchRealComments(article, html);
  article.comments = realComments.length ? realComments : (ALLOW_SYNTHETIC_COMMENTS ? buildComments(article, html) : []);
  article.commentSource = realComments.length ? 'real' : (ALLOW_SYNTHETIC_COMMENTS ? 'synthetic' : 'none');
  article.stats.comments = article.comments.length;
  return article;
}

/* 从候选里挑一个真正的图片 URL（排除文章页/接口页、二维码/logo 等垃圾封面）
 * 网易 nimg.ws.126.net/?url=…、新浪 k.sinaimg.cn、腾讯 p.qpic.cn 等 CDN 代理图
 * 都不带 .jpg/.png 后缀，不能按后缀拒，否则这些源封面全空——只认“http(s) 真图 + 非垃圾”。 */
function pickCover(candidates, base) {
  for (const c of candidates) {
    const u = absolute(c, base);
    if (!u || !/^https?:\/\//i.test(u)) continue;
    // 文章页 / 接口页 / 样式脚本不要当封面
    if (/\.(html?|shtml|php|aspx?|jsp|css|js|json|xml)(\?|#|$)/i.test(u)) continue;
    if (badImage(u, '', '')) continue; // 跳过二维码 / 动图 / logo 等垃圾封面
    return u;
  }
  return '';
}

/* 从整页 HTML 里兜底提取真实图片 URL（IT之家等站的图是懒加载，不在 <img src> 里） */
function extractImageUrls(html) {
  const urls = String(html || '').match(/https?:\/\/[^\s"'<>()\\]+\.(?:jpe?g|png|webp|gif)/gi) || [];
  const out = []; const seen = new Set();
  for (const u of urls) {
    const k = imgDedupKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    if (/t\.png|logo|icon|avatar|sprite|spacer|pixel|qrcode|badge|\/ad[s]?\//i.test(u)) continue;
    if (isQrLike(u, '', '')) continue;          // 订阅/关注二维码
    if (/\.svg/i.test(u) || /\.gif/i.test(u) || u.length < 25) continue;
    out.push(u);
    if (out.length >= MAX_CONTENT_IMGS) break;
  }
  return out;
}

/* 文章页不可达时的降级：用 RSS 摘要生成一条快讯，保证多源内容不为空 */
async function rssFallbackArticle(item, source, html) {
  // RSS 正文常是纯文本（无 <p>/<img> 标签），此时直接用完整纯文本，不能退回截断的 summary
  const raw = item.rssContent || '';
  const plain = clean(raw);
  let content = [];
  if (raw.length > 200) {
    try { content = contentBlocks(stripNoise(raw), item.url); } catch (_) { content = []; }
  }
  const textFromBlocks = content.filter(b => b.text).map(b => b.text).join('\n\n');
  let text = plain.length > textFromBlocks.length ? plain : textFromBlocks;
  // 纯文本时按句号/换行拆段，避免整坨显示
  if (!content.length && text.length > 40) {
    content = text.split(/\n+|(?<=[。！？；])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 8 && !isFooterOrPromo(s))
      .map(s => ({ type: 'p', text: s }));
  }
  text = (text || clean(item.summary || '')).trim();
  // 降级文章同样要满足最低字数，避免把过短的 RSS 摘要塞进公众号
  const minChars = source.minChars || MIN_BODY_CHARS;
  if (text.length < minChars) return null;

  // 封面：优先用 RSS 正文里自己的图。第一张图常被微信塞成二维码/logo 被 badImage 跳过，
  // 因此把正文【所有】图按顺序都投给 pickCover，取第一张非垃圾图，避免“有图却无封面”。
  const firstRawImg = (raw.match(/<img[^>]+src=["']([^"']+)/i) || [])[1] || '';
  const allContentImgs = content.filter(b => b.type === 'img' && b.src).map(b => b.src);
  const ts = item.ts || Date.now();
  const article = {
    id: item.id,
    title: cleanTitle(item.title, source),
    summary: clean(text).slice(0, 200),
    body: text.slice(0, MAX_TEXT),
    content: content.length ? content : [{ type: 'p', text: text }],
    url: item.url,
    cover: pickCover([...allContentImgs, firstRawImg, item.rssCover], item.url || source.siteUrl),
    ts: ts,
    date: dateText(ts),
    type: '图文',
    author: item.rssAuthor || source.name,
    sourceName: source.name,
    accountName: source.name,
    topics: item.topics || ['news'],
    degraded: true,
  };
  if (!shouldKeep(article, source)) return null;
  article.stats = buildStats(article, 0);
  article.read = article.stats.read;
  const realComments = await fetchRealComments(article, '');
  article.comments = realComments.length ? realComments : (ALLOW_SYNTHETIC_COMMENTS ? buildComments(article, '') : []);
  article.commentSource = realComments.length ? 'real' : (ALLOW_SYNTHETIC_COMMENTS ? 'synthetic' : 'none');
  article.stats.comments = article.comments.length;
  return article;
}

/* 新浪实时接口的分页：把 URL 里的 page= 换成指定页码（没有该参数就补上）。
   同一频道不同页返回不同文章，用来把候选池从 20 条扩到 20×pages 条，
   否则单页筛完（新浪单篇普遍 300~800 字）根本凑不出几篇长文。 */
function sinaUrlWithPage(url, page) {
  if (/[?&]page=\d+/.test(url)) return url.replace(/([?&]page=)\d+/, '$1' + page);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'page=' + page;
}

async function collect(source) {
  // 列表抓取：RSS 为主；网易等无 RSS 的站点走 JSONP 列表接口（见 parseNeteaseJson）。
  // 若返回空（被临时限流/返回挑战页），退避重试，保证来源稳定
  let xml = '';
  const feedUrl = resolveFeedUrl(source.feedUrl);
  // 三种列表形态：新浪实时 JSON、网易 JSONP、标准 RSS。
  // 新浪 RSS 与网易 RSS 均已废弃/下线，故这两家只能走各自的 JSON 接口。
  const mode = (source.type === 'sina-json' || /feed\.sina\.com\.cn/i.test(feedUrl)) ? 'sina'
    : (source.type === 'jsonp' || source.type === 'netease-json' || /\.js(\?|$)/i.test(feedUrl) || /3g\.163\.com/i.test(feedUrl)) ? 'netease'
      : 'rss';
  const parseList = t => (mode === 'sina' ? parseSinaJson(t, source) : mode === 'netease' ? parseNeteaseJson(t, source) : parseDiscovery(t, source));
  const perPage = Number(source.limit || 12);
  const pages = (mode === 'sina') ? Math.max(1, Number(source.pages || 1)) : 1;
  // 起始页码：多个账号共用一个频道时必须错开区间，否则翻页范围重叠，
  // 后面账号的文章会在"全局按 URL 去重"时被判为重复而整号清空。
  const pageStart = (mode === 'sina') ? Math.max(1, Number(source.pageStart || 1)) : 1;
  let discovered = [];
  if (pages > 1) {
    // 多页合并：单页失败不影响其他页
    for (let p = 0; p < pages; p++) {
      const pageNum = pageStart + p;
      let t = '';
      try { t = await request(sinaUrlWithPage(feedUrl, pageNum), 0, source.gap); } catch (e) { console.warn('FEED-FAIL ' + source.name + ' p' + pageNum + ': ' + e.message); }
      discovered = discovered.concat(parseList(t));
      if (p < pages - 1) await sleep(120);
    }
    const seen = new Set();
    discovered = discovered.filter(it => {
      const k = it.url || it.id;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } else {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { xml = await request(feedUrl, 0, source.gap); } catch (e) { console.warn('FEED-FAIL ' + source.name + ': ' + e.message); xml = ''; }
      if (parseList(xml).length) break;
      if (attempt < 2) await sleep(700 * (attempt + 1));
    }
    discovered = parseList(xml);
  }
  // 列表为空时打印原因，否则"某源 0 篇"只能盲猜：常见原因是列表接口被限流、
  // 返回挑战页，或 RSS 里的链接被 isListPageUrl 全部过滤掉。
  if (!discovered.length) {
    console.warn('EMPTY-LIST ' + source.name + ' [' + mode + '] raw=' + String(xml || '').length + 'B ' + feedUrl);
  }
  // 多页模式下候选变多，候选上限同步放宽，否则翻页白翻
  discovered = discovered.slice(0, Math.min(perPage * pages, 120));
  const articles = await mapLimit(discovered, async item => {
    // fullFromRss：RSS 的 content:encoded 已含全文，直接用它组装文章，
    // 不再去抓微信文章页（既慢又会触发微信风控）。仅作来源全文兜底。
    if (source.fullFromRss) {
      return await rssFallbackArticle(item, source, '');
    }
    // 优先抓全文页；失败或正文太短时降级用 RSS 摘要，但保留文章页 HTML 用于兜底取图
    let html = '';
    let full = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        html = await request(item.url);
        full = await pageArticle(item, source, html);
        if (full) break;
      } catch (_) { /* 文章页不可达，下一轮或走降级 */ }
      if (attempt < 1) await sleep(500);
    }
    if (full) return full;
    return await rssFallbackArticle(item, source, html);
  });
  // 抓到真实评论的排前面（其次按时间），保证账号列表里优先露出有真评论的文章
  return articles.sort((a, b) => {
    const ar = a.commentSource === 'real' ? 1 : 0;
    const br = b.commentSource === 'real' ? 1 : 0;
    if (ar !== br) return br - ar;
    return b.ts - a.ts;
  });
}

/* ---------- 历史池 ---------- */

function trimForHistory(article) {
  // 清理历史记录：限制图片数量，确保质量
  const cleanContent = (article.content || []).filter(b => b.type === 'img' ? (b._imgCount = (++b._imgCount || 0) <= 15) : true).slice(0, 25);
  // 重新编号图片
  let imgCount = 0;
  cleanContent.forEach(b => { if (b.type === 'img') { imgCount++; b._imgCount = imgCount; } });
  
  return Object.assign({}, article, {
    content: cleanContent,
    comments: (article.comments || []).slice(0, 6),
  });
}

function mergeHistory(liveArticles) {
  const old = readJson(HISTORY_FILE, []);
  const byId = new Map();
  old.forEach(a => { if (a && a.id) byId.set(a.id, a); });
  liveArticles.forEach(a => byId.set(a.id, trimForHistory(a)));
  return Array.from(byId.values()).sort((a, b) => b.ts - a.ts).slice(0, HISTORY_LIMIT);
}

/* ---------- 内容库（持续累积 + 已展示去重）---------- */

function readLibrary() {
  const lib = readJson(LIBRARY_FILE, null);
  if (lib && lib.byId && typeof lib.byId === 'object') return lib;
  return { version: 1, updatedAt: '', byId: {} };
}
function writeLibrary(lib) {
  lib.updatedAt = new Date().toISOString();
  writeJson(LIBRARY_FILE, lib);
}

// 把抓取到的文章并入库：新文章写入（shown=false），已有文章更新正文但保留其展示状态。
function libMerge(lib, accountId, sourceName, articles) {
  for (const a of articles) {
    if (!a || !a.id) continue;
    const prev = lib.byId[a.id];
    if (prev) {
      const shown = prev._shown, shownAt = prev._shownAt, crawledAt = prev._crawledAt || Date.now();
      Object.assign(prev, a);
      prev._account = accountId;
      prev._source = sourceName;
      prev._crawledAt = crawledAt;
      prev._shown = shown;
      prev._shownAt = shownAt;
    } else {
      const rec = Object.assign({}, a);
      rec._account = accountId;
      rec._source = sourceName;
      rec._crawledAt = Date.now();
      rec._shown = false;
      rec._shownAt = null;
      lib.byId[a.id] = rec;
    }
  }
}

function stripMeta(a) {
  const c = JSON.parse(JSON.stringify(a));
  delete c._account; delete c._source; delete c._crawledAt; delete c._shown; delete c._shownAt;
  return c;
}

// 从库里取该账号最多 n 篇“未展示”文章，取出即标记为已展示。
function libPopUnseen(lib, accountId, n) {
  const cand = Object.values(lib.byId).filter(a => a._account === accountId && !a._shown);
  cand.sort((x, y) => (y._crawledAt || 0) - (x._crawledAt || 0));
  const out = [];
  for (const a of cand) {
    if (out.length >= n) break;
    a._shown = true;
    a._shownAt = Date.now();
    out.push(stripMeta(a));
  }
  return out;
}

// 未展示耗尽时，回退取该账号“最久未展示”的文章（优先重展示最旧的），保证账号不为空。
function libRecycle(lib, accountId, n, exclude) {
  const cand = Object.values(lib.byId).filter(a => a._account === accountId && (!exclude || !exclude.has(a.id)));
  cand.sort((x, y) => (x._shownAt || x._crawledAt || 0) - (y._shownAt || y._crawledAt || 0));
  const out = [];
  for (const a of cand) {
    if (out.length >= n) break;
    a._shown = true;
    a._shownAt = Date.now();
    out.push(stripMeta(a));
  }
  return out;
}

// 裁剪到 LIBRARY_MAX：优先删最旧的“已展示”文章，其次最旧的未展示文章。
function libPrune(lib, max) {
  const ids = Object.keys(lib.byId);
  if (ids.length <= max) return;
  const arr = ids.map(id => lib.byId[id]);
  arr.sort((x, y) => {
    const rx = x._shown ? (x._shownAt || x._crawledAt || 0) : (x._crawledAt || 0);
    const ry = y._shown ? (y._shownAt || y._crawledAt || 0) : (y._crawledAt || 0);
    return rx - ry;
  });
  const drop = arr.length - max;
  for (let i = 0; i < drop; i++) delete lib.byId[arr[i].id];
}

/* ---------- 主流程 ---------- */

/* 出口兜底：正文里若混进被转义的 HTML 源码（&lt;p data-vmark="…"&gt; 解码后成真标签），
   在写进 feed 之前统一剥掉。用标签名白名单，技术文章里的代码示例（<key>、<signType>、
   <stdlib.h>、<?xml …?>）不在白名单，不会被误伤。 */
function sanitizeArticleText(article) {
  if (!article) return article;
  const fix = t => {
    const s = String(t == null ? '' : t);
    if (!looksLikeHtmlRemainder(s)) return s;
    return stripEscapedTags(s).replace(/\s{2,}/g, ' ').replace(/\n\s+/g, '\n').trim();
  };
  if (Array.isArray(article.content)) {
    article.content = article.content.filter(b => b && b.type).map(b => {
      if (b.type !== 'p' || typeof b.text !== 'string') return b;
      const t = fix(b.text);
      return t ? Object.assign({}, b, { text: t }) : null;
    }).filter(Boolean);
  }
  if (typeof article.body === 'string') article.body = fix(article.body);
  if (typeof article.summary === 'string') article.summary = fix(article.summary);
  return article;
}

function account(source, articles) {
  (articles || []).forEach(sanitizeArticleText);
  return {
    id: source.id,
    name: source.name,
    desc: source.desc || '',
    avatar: '',
    lastPushAt: articles[0] ? articles[0].ts : Date.now(),
    articles
  };
}

// 检查是否为快讯类内容（不应出现在公众号）
function isNewsOnly(article) {
  const newsTopics = ['news', 'society'];
  const newsKeywords = ['政策', '民生', '奇闻', '真相', '揭秘', '维权', '突发'];
  const text = (article.title + ' ' + article.summary).toLowerCase();
  
  // 如果话题是news/society，直接返回true
  if (article.topics && article.topics.some(t => newsTopics.includes(t))) return true;
  
  // 如果标题包含新闻关键词，且文字内容较短（<500字），可能是快讯
  if (newsKeywords.some(kw => text.includes(kw.toLowerCase())) && article.body.length < 500) return true;
  
  return false;
}

function breakingPool(items) {
  const sorted = items.sort((a, b) => b.ts - a.ts).map((item, index) => Object.assign({ poolIndex: index }, item));
  sorted.forEach((article, index) => {
    article.recommendations = [1, 2, 3, 4, 5].map(n => sorted[(index + n) % sorted.length]).filter(Boolean).map(x => ({ poolIndex: x.poolIndex, title: x.title, cover: x.cover, ts: x.ts, accountName: x.accountName || x.sourceName, read: x.read }));
  });
  // 对快讯列表中的文章也应用图片过滤
  sorted.forEach(article => {
    if (article.content && article.content.length > 10) {
      const filteredImgs = article.content.filter(b => b.type !== 'img').slice(0, 25);
      // 最多保留 MAX_CONTENT_IMGS 张图片
      let imgCount = 0;
      article.content.forEach(b => {
        if (b.type === 'img' && imgCount < MAX_CONTENT_IMGS) {
          filteredImgs.push(b);
          imgCount++;
        }
      });
      article.content = filteredImgs;
    }
  });
  return { name: '快讯', count: sorted.length, items: sorted };
}

// 清理文章：限制图片数量，确保内容质量
/* 按正文字数均匀铺设插图：约每 IMG_DENSITY 字一张，最多 MAX_CONTENT_IMGS 张，
   首图在 ≥2 个文字块之后，相邻两图之间至少隔 MIN_TEXT_BLOCKS_BETWEEN_IMGS 个文字块，不堆首尾 */
function layoutContent(blocks) {
  if (!blocks || blocks.length < 1) return blocks;

  const texts = blocks.filter(b => b.type !== 'img');
  const imgs = [];
  const seen = new Set();
  for (const b of blocks) {
    if (b.type === 'img' && b.src) {
      const key = imgDedupKey(b.src);
      if (!seen.has(key)) { seen.add(key); imgs.push(b); }
    }
  }
  if (!texts.length || !imgs.length) return blocks;

  const textLen = texts.reduce((n, b) => n + (b.text ? b.text.length : 0), 0);
  const want = Math.floor(textLen / IMG_DENSITY);
  const step = MIN_TEXT_BLOCKS_BETWEEN_IMGS + 1;   // 相邻图之间的文字块步长
  const N = texts.length;

  // 文字块可容纳的插图数（首图在 ≥2 文字块后，之后每隔 step 个文字块一张）
  const capacity = imgs.length ? (N <= 1 ? 1 : Math.max(1, Math.floor((N - 1 - 2) / step) + 1)) : 0;
  // 四重约束：字数密度 / 图片数 / 上限 / 文字块容纳量
  const slots = Math.max(0, Math.min(want, imgs.length, MAX_CONTENT_IMGS, capacity));
  if (slots === 0) return blocks;

  // 计算均匀且互不冲突的插图位置（pBefore[k] = 该图之前应发出的文字块数）
  const place = [];
  let prev = -99;
  for (let k = 0; k < slots; k++) {
    const p = (k === 0) ? (N <= 1 ? 1 : Math.min(2, N - 1)) : prev + step;
    if (p > N - 1) break;                            // 文字块不够，后续图不再放
    place.push(p);
    prev = p;
  }

  // 组装：已发出 ti 个文字块时，若等于下一张图的目标位置则插入该图
  const out = [];
  let ti = 0, si = 0;
  while (ti < N || si < place.length) {
    if (si < place.length && place[si] === ti) {
      out.push(imgs[si++]);
    } else {
      out.push(texts[ti++]);
    }
  }
  return out;
}

function cleanArticle(article) {
  if (!article.content) return article;
  article.content = layoutContent(article.content);
  return article;
}

async function main() {
  const config = readJson(CONFIG_FILE, { breakingSources: [], accounts: [] });
  const old = readJson(FEED_FILE, { accounts: [], breakingPool: { items: [] } });
  const lib = readLibrary();   // 跨运行持久化的内容库（已展示去重 + 持续累积）

  // 1. 抓取快讯源（只用于快讯池）
  const breakingResults = await Promise.all((config.breakingSources || []).map(async source => {
    try {
      const rows = await collect(source);
      console.log(`${source.name}: ${rows.length} articles`);
      return rows;
    } catch (e) {
      console.warn(`${source.name}: ${e.message}`);
      return [];
    }
  }));

  // 2. 抓取公众号源（过滤掉快讯类内容），全量入库累积，构建 feed 时只取“未展示”
  // 只保留能抓到全文的源（disabled 或 enabled:false 的源跳过）
  const accountSources = (config.accounts || []).filter(s => !s.disabled && s.enabled !== false);
  // CI（GitHub Actions）上跳过本地源（如 wechat-download-api 的 localhost:5000），云端跑不到
  const isCI = !!process.env.GITHUB_ACTIONS;
  const accountResults = await Promise.all(accountSources.map(async source => {
    if (isCI && /^https?:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(source.feedUrl || '')) {
      // 必须与下面统一返回 { source, ranked } 结构，否则 liveAccounts 取 r.source.id 会崩
      return { source, ranked: [], fetched: 0, afterFilter: 0 };
    }
    try {
      const rows = await collect(source);
      // 每个来源都作为公众号账号呈现（含时政/社会类），仅按账号关键词做题材分流
      const kwFiltered = rows.filter(a => {
        if (source.keywords && source.keywords.length) {
          const t = (a.title || '') + (a.body || '');
          return source.keywords.some(k => t.includes(k));
        }
        return true;
      });
      // 关键词过滤后过于稀疏就退回全部：窄关键词源会把十来篇滤到 1~2 篇
      // （"财经速递"只认物价/养老金/银行，11 篇只剩 1 篇），源几乎被掏空。
      // 命中数不足 3 篇说明关键词太窄，此时保留全部抓取结果。
      const filtered = kwFiltered.length >= Math.min(3, rows.length) ? kwFiltered : rows;
      // 每个账号限量取优：有真实评论的优先，其次篇幅长的优先，避免短文/无评论文占位
      const ranked = filtered.slice().sort((a, b) => {
        const ar = a.commentSource === 'real' ? 1 : 0;
        const br = b.commentSource === 'real' ? 1 : 0;
        if (ar !== br) return br - ar;
        // 有配图的排前面：公众号图文没图观感差，但这里不做硬性淘汰——
        // 中新网等通讯社稿大量本身无图，硬卡 minImgs 会把整个源清空。
        // 只让带图文章优先占位，无图长文排在后面兜底。
        const hasImg = x => (x.content || []).some(b2 => b2 && b2.type === 'img');
        const ai = hasImg(a) ? 1 : 0, bi = hasImg(b) ? 1 : 0;
        if (ai !== bi) return bi - ai;
        return (b.body || '').length - (a.body || '').length;
      });
      // 只排序不入库：先交给下面的 AI 筛选闸门统一判定，避免每源各调一次接口
      return { source, ranked, fetched: rows.length, afterFilter: filtered.length };
      } catch (e) {
        console.warn(`${source.name}: ${e.message}`);
        return { source, ranked: [], fetched: 0, afterFilter: 0 }; // 抓取失败时保留账号，稍后用历史兜底
      }
    }));

  // 2.5 规则筛选直通（AI 闸门已移除）：不再调模型，仅按长度把短文分流进快讯池，长文进公众号
  const allRanked = [];
  accountResults.forEach(r => (r.ranked || []).forEach(a => { if (a) allRanked.push(a); }));
  const verdicts = await filterArticles(allRanked, { log: console.log });
  const extraNews = [];
  let aiDropped = 0, aiToNews = 0;

  const liveAccounts = accountResults.map(r => {
    const keepList = [], newsList = [];
    (r.ranked || []).forEach(a => {
      const v = verdicts.get(a);
      if (v && v.keep === false) { aiDropped++; return; }
      if (v && v.category === 'news') { newsList.push(a); aiToNews++; }
      else keepList.push(a);
    });
    // 关键改动：把“全部候选”（不止 keep 篇）写入内容库累积，库随持续抓取增长 → “数量”
    libMerge(lib, r.source.id, r.source.name, keepList);
    // 构建 feed 时按账号取“未展示”文章；数量不够再回退到最旧已展示的，保证账号不空
    const n = Math.max(Number(r.source.keep || 0), SERVE_KEEP);
    let picked = libPopUnseen(lib, r.source.id, n);
    if (RECYCLE_WHEN_EMPTY && picked.length < n) {
      const need = n - picked.length;
      picked = picked.concat(libRecycle(lib, r.source.id, need, new Set(picked.map(a => a.id))));
    }
    if (r.ranked && r.ranked.length) {
      console.log(`${r.source.name}: ${r.fetched} fetched, ${r.afterFilter} after filter, ${picked.length} served (AI 剔除 ${r.ranked.length - keepList.length - newsList.length}, 短流转快讯 ${newsList.length})`);
    }
    extraNews.push(...newsList);
    return account(r.source, picked); // 保留空账号以便历史兜底
  });
  if (aiDropped || aiToNews) console.log(`[合计] AI 剔除 ${aiDropped} 篇，短文转快讯 ${aiToNews} 篇`);

  // 3. 生成合成文章（用于纯合成账号）
  const syntheticAccounts = [];
  (config.accounts || []).forEach(source => {
    if (source.synthetic) {
      const synthArticles = generateSyntheticArticles(0);
      syntheticAccounts.push(account(source, synthArticles));
      console.log(`Synthesized ${synthArticles.length} articles for ${source.name}`);
    }
  });

  // 快讯池同样入库累积 + 去重：已展示过的快讯不再重复进入“快讯”流
  // 这里并入 AI 判定为 news 的短文 —— “短文章进新闻”
  const rawBreaking = breakingResults.flat().concat(extraNews);
  libMerge(lib, 'breaking', '快讯', rawBreaking);
  let liveBreaking = libPopUnseen(lib, 'breaking', 30);
  if (RECYCLE_WHEN_EMPTY && liveBreaking.length < 30) {
    liveBreaking = liveBreaking.concat(libRecycle(lib, 'breaking', 30 - liveBreaking.length, new Set(liveBreaking.map(a => a.id))));
  }
  // 按 dest 分流：kan -> 看一看，其余 -> 关注号
  const kanIds = new Set((config.accounts || []).filter(s => !s.disabled && s.enabled !== false && s.dest === 'kan').map(s => s.id));
  const liveOfficial = liveAccounts.filter(a => !kanIds.has(a.id));
  const liveKan = liveAccounts.filter(a => kanIds.has(a.id));

  // 4. 合并历史
  const history = mergeHistory(liveBreaking.concat(liveAccounts.flatMap(a => a.articles)));
  writeJson(HISTORY_FILE, history);
  const historyBySource = new Map();
  history.forEach(a => {
    if (!historyBySource.has(a.sourceName)) historyBySource.set(a.sourceName, []);
    historyBySource.get(a.sourceName).push(a);
  });

  // 5. 构建「关注号」feed（dest != kan）
  const fallbackBreaking = liveBreaking.length ? liveBreaking : (old.breakingPool?.items?.length ? old.breakingPool.items : history.filter(a => !isNewsOnly(a)).slice(0, 20));
  
  const accounts = [
    ...liveOfficial,
    ...syntheticAccounts
  ].map(acc => {
    // 本次没抓到就用历史池里同源的文章兜底，保证账号稳定存在
    if (!acc.articles.length) {
      // 历史兜底也要满足最低字数，避免旧短讯污染公众号
      const minChars = acc.minChars || MIN_BODY_CHARS;
      acc.articles = (historyBySource.get(acc.name) || [])
        .filter(a => (a.body || '').length >= minChars)
        .slice(0, 8);
    }
    acc.articles = acc.articles.map(cleanArticle);
    return acc;
  }).filter(a => a.articles.length);

  if (!fallbackBreaking.length && !accounts.length) throw new Error('No content available');

  const pool = breakingPool(fallbackBreaking.slice(0, 30));

  // 全局去重：同一文章 URL 只保留首次出现（跨账号与快讯池统一去重）
  {
    const seen = new Set();
    const dedup = arr => (arr || []).filter(a => { if (!a || !a.url) return true; const k = String(a.url).split('#')[0]; if (seen.has(k)) return false; seen.add(k); return true; });
    accounts.forEach(acc => {
      const original = acc.articles || [];
      const kept = dedup(original);
      // 新浪各频道（财经/股市/科技/国际）常有同一篇文章，跨账号去重可能把某个账号
      // 整号清空。空账号比跨号重复更伤体验，因此若整号被去重清空则保留它自己那份。
      acc.articles = (original.length && !kept.length) ? original : kept;
    });
    pool.items = dedup(pool.items);
  }
  const feed = {
    generatedAt: new Date().toISOString(),
    source: 'live-web',
    breaking: pool.items.length ? { poolIndex: 0, count: pool.items.length, article: pool.items[0] } : null,
    breakingPool: pool,
    accounts
  };
  
  // 写盘前统一把 http 明文图片升级为 https，避免在 https 页面上被浏览器按混合内容拦截成裂图
  upgradeFeedImages(feed);
  writeJson(FEED_FILE, feed);

  // 5b. 构建「看一看」feed（dest == kan）：真实公众号推荐流，复用内容库去重
  // 体量控制：只靠 LOOK_KEEP（每号留最新 2 篇）控总量，正文本身不截断——
  // 早期按 LOOK_MAX_TEXT=6000 截断会把长文砍断（用户反馈“没说完”），现已取消该截断。
  function trimLookArticle(article) {
    const a = Object.assign({}, article);
    const blocks = (a.content || []).filter(b => b && b.text);
    const ctext = blocks.map(b => b.text).join('');
    // content 已是抓取器按 MAX_BLOCKS/MAX_TEXT 收口的完整正文——
    // 这里绝不再二次截断（原先的 LOOK_MAX_TEXT=6000 会把长文拦腰砍断，用户明确反馈“没说完”）。
    // 仅当 content 过短（半成品降级稿）时保留 body 兜底；content 正常则丢弃冗余 body 省体积。
    if (a.content && a.content.length && ctext.length >= 200) delete a.body;
    return a;
  }
  const lookAccounts = liveKan.map(acc => {
    const sorted = (acc.articles || []).slice().sort((x, y) => (y.ts || 0) - (x.ts || 0));
    acc.articles = sorted.slice(0, LOOK_KEEP).map(cleanArticle).map(trimLookArticle);
    return acc;
  }).filter(a => a.articles.length);
  {
    const seen = new Set();
    const dedup = arr => (arr || []).filter(a => { if (!a || !a.url) return true; const k = String(a.url).split('#')[0]; if (seen.has(k)) return false; seen.add(k); return true; });
    lookAccounts.forEach(acc => {
      const original = acc.articles || [];
      const kept = dedup(original);
      acc.articles = (original.length && !kept.length) ? original : kept;
    });
  }
  const lookFeed = {
    generatedAt: new Date().toISOString(),
    source: 'wechat2rss',
    breakingPool: { name: '看一看', count: 0, items: [] },
    accounts: lookAccounts
  };
  upgradeFeedImages(lookFeed);
  writeJson(LOOK_FEED_FILE, lookFeed);

  // 内容库裁剪到上限并落盘（CI 会把本文件提交回仓库，实现“在 GitHub 上持续累积”）
  libPrune(lib, LIBRARY_MAX);
  writeLibrary(lib);

  console.log(`Wrote feed: ${accounts.length} 关注号, ${lookAccounts.length} 看一看, ${pool.items.length} breaking, history ${history.length}, library ${Object.keys(lib.byId).length} (shown=${Object.values(lib.byId).filter(a => a._shown).length}).`);
}

function upgradeFeedImages(feed) {
  const fixArticle = a => {
    if (!a) return;
    if (a.cover) a.cover = toHttps(a.cover);
    if (Array.isArray(a.content)) a.content.forEach(b => { if (b && b.type === 'img' && b.src) b.src = toHttps(b.src); });
  };
  (feed.accounts || []).forEach(acc => (acc.articles || []).forEach(fixArticle));
  const items = ((feed.breakingPool || {}).items) || [];
  items.forEach(fixArticle);
  if (feed.breaking && feed.breaking.article) fixArticle(feed.breaking.article);
  items.forEach(a => (a.recommendations || []).forEach(r => { if (r && r.cover) r.cover = toHttps(r.cover); }));
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
