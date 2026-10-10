#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FEED_FILE = path.join(ROOT, 'data', 'channels-feed.json');
const POOL_FILE = path.join(ROOT, 'data', 'video-pool.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'channels-history.json');
const POOL_TARGET = 5000;
const FEED_SIZE = 1500;

// ---------- 评论抓取参数 ----------
// 每轮最多给多少条「尚无评论」的视频补抓；以及整个 feed 最多允许多少条带评论（控制体积）。
// 1500 条全带评论约 30MB，对 APK 远程拉取太重，故封顶 600 条（≈12MB）。
const COMMENT_FETCH_PER_RUN = 300;
const COMMENT_COVERAGE_CAP = 600;
const COMMENT_TARGET = 80;          // 每个视频最多取多少条评论
const COMMENT_PS = 20;              // 每页条数
const COMMENT_DELAY_MIN = 150;
const COMMENT_DELAY_MAX = 350;
const HISTORY_DAYS = 30;
const DELAY_MIN_MS = 4000;
const DELAY_MAX_MS = 8000;

const POPULAR_PAGES = 20;
const PRECIOUS_PAGES = 3;

const BLOCK_WORDS = [
  '恐怖', '暴力', '吵架', '整蛊', '擦边', '抽卡', '赌博', '彩票', '性感', '美女',
  '减肥神药', '神药', '保健品', '投资', '荐股', '贷款', '网贷', '直播带货', '带货',
  '速赚', '暴富', '玄学', '算命', '灵异', '血腥', '虎门抽烟', '胆汁'
];

const FALLBACK_ITEMS = [
  { bvid: 'BV1JhZcY9EFN', title: '生活记录精选', author: 'B站', keyword: '备用视频', likes: '1000', duration: 334, width: 1080, height: 1920 },
  { bvid: 'BV1fpZ6YaE47', title: 'B站精选', author: 'B站', keyword: '备用视频', likes: '303567', duration: 202, width: 1440, height: 2560 },
  { bvid: 'BV1AiZEY5Etd', title: '短视频精选', author: 'B站', keyword: '备用视频', likes: '1000', duration: 132, width: 1080, height: 1920 },
  { bvid: 'BV1GWZnYcEsu', title: 'B站精选', author: 'B站', keyword: '备用视频', likes: '398688', duration: 29, width: 2160, height: 3840 }
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function sleep(min, max) {
  const ms = min + Math.floor(Math.random() * Math.max(1, max - min));
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestRaw(url, cookieJar) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Cookie': cookieJar || ''
      },
      timeout: 15000
    }, res => {
      const setCookie = res.headers['set-cookie'] || [];
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body, setCookie }));
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout ${url}`)));
    req.on('error', reject);
  });
}

async function warmupCookies() {
  const res = await requestRaw('https://www.bilibili.com/', '');
  const jar = res.setCookie
    .map(line => line.split(';')[0])
    .filter(Boolean)
    .join('; ');
  return jar;
}

async function requestJson(url, cookieJar) {
  const res = await requestRaw(url, cookieJar);
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} ${url}`);
  const json = JSON.parse(res.body.replace(/^\uFEFF/, ''));
  if (json && (json.code === -352 || json.code === -799 || json.code === 412)) {
    const err = new Error(`Bilibili risk-control code ${json.code}`);
    err.riskControl = true;
    throw err;
  }
  if (!json || json.code !== 0) throw new Error(`Bilibili code ${json && json.code}`);
  return json;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------- WBI 签名：评论接口 x/v2/reply/wbi/main 需要 ----------
// 无签名只能走旧接口 x/v2/reply（仅吐 3 条热门）；带签名可翻页取到 80 条。
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

let _wbiKeys = null;

async function getWbiKeys(cookieJar) {
  if (_wbiKeys) return _wbiKeys;
  // 注意：不能用 requestJson —— 它强制 code===0，而 nav 未登录时返回 code=-101，
  // 但 data.wbi_img 依然有效。这里只取 wbi_img，不校验业务 code。
  const res = await requestRaw('https://api.bilibili.com/x/web-interface/nav', cookieJar);
  let json;
  try {
    json = JSON.parse(String(res.body || '').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error('nav JSON parse failed');
  }
  const wbi = json && json.data && json.data.wbi_img;
  if (!wbi) throw new Error('no wbi_img in nav');
  const imgKey = String(wbi.img_url || '').split('/').pop().split('.')[0];
  const subKey = String(wbi.sub_url || '').split('/').pop().split('.')[0];
  const orig = imgKey + subKey;
  let mixin = '';
  for (const i of MIXIN_KEY_ENC_TAB) mixin += orig[i] || '';
  _wbiKeys = { mixin: mixin.slice(0, 32) };
  return _wbiKeys;
}

function buildWbiUrl(base, params) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const keys = Object.keys(p).sort();
  const qs = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join('&');
  const signed = _wbiKeys
    ? `${qs}&w_rid=${crypto.createHash('md5').update(qs + _wbiKeys.mixin).digest('hex')}`
    : qs;
  return base + (base.includes('?') ? '&' : '?') + signed;
}

async function fetchCommentsForBvid(bvid, cookieJar) {
  // 注意：wbi/main 不能走 requestJson —— 它的严格 code 校验会吞掉降级响应。
  // 实测：同接口走 requestRaw（完整 Sec-Fetch 头 + cookie）能拿到 20/页，
  // 走 requestJson 路径会被 B 站按「未验证站点」降到 3 条热门。
  let aid = 0;
  try {
    const vres = await requestRaw(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, cookieJar);
    const vjson = JSON.parse(vres.body.replace(/^\uFEFF/, ''));
    aid = (vjson && vjson.data && vjson.data.aid) || 0;
  } catch (err) {
    return [];
  }
  if (!aid) return [];

  const out = [];
  let next = 0;
  for (let page = 0; page < 6 && out.length < COMMENT_TARGET; page += 1) {
    let data;
    try {
      const url = buildWbiUrl('https://api.bilibili.com/x/v2/reply/wbi/main', {
        oid: aid, type: 1, mode: 3, next, ps: COMMENT_PS, plat: 1, web_location: '1315875'
      });
      const res = await requestRaw(url, cookieJar);
      const json = JSON.parse(res.body.replace(/^\uFEFF/, ''));
      if (!json || json.code !== 0) break;
      data = json.data;
    } catch (err) {
      break;
    }
    if (!data) break;
    const replies = data.replies || [];
    if (!replies.length) break;
    replies.forEach(c => {
      out.push({
        name: (c.member && c.member.uname) || '',
        avatar: String((c.member && c.member.avatar) || '').replace(/^http:\/\//, 'https://'),
        text: (c.content && c.content.message) || '',
        like: Number(c.like || 0),
        time: Number(c.ctime || 0)
      });
    });
    const cursor = data.cursor;
    if (!cursor || cursor.is_end) break;
    next = Number(cursor.next || 0);
    if (!next) break;
    await sleep(COMMENT_DELAY_MIN, COMMENT_DELAY_MAX);
  }
  return out.slice(0, COMMENT_TARGET);
}

// 评论合成：①继承上一轮 feed 已有的评论（pool 不存评论，不继承就会每轮被冲掉）
//          ②对「排在最前且尚无评论」的若干条补抓，直到覆盖数达到上限
//
// 关键：抓评论时传空 cookie（不带 warmupCookies 的 session）
// 实测：同一 wbi/main 接口，带 cookie jar 会被 B 站降级到 3 条热门；
//       不带 cookie（干净 UA+Referer 头）能稳定拿 20 条/页。
// 因此 buildComments 内部一律用 '' 作为 cookieJar，忽略外部传入。
async function buildComments(feedItems, oldFeed, cookieJar) {
  const emptyJar = ''; // 强制不用外部 cookie，见上方注释

  const oldComments = new Map();
  (oldFeed.items || []).forEach(item => {
    if (item && item.bvid && Array.isArray(item.comments) && item.comments.length) {
      oldComments.set(item.bvid, item.comments);
    }
  });

  let inherited = 0;
  const missing = [];
  feedItems.forEach(item => {
    const prev = oldComments.get(item.bvid);
    if (prev) {
      item.comments = prev;
      inherited += 1;
    } else {
      item.comments = [];
      missing.push(item);
    }
  });

  console.log(`Comments: inherited ${inherited} from previous feed; ${missing.length} without.`);

  let covered = inherited;
  let fetched = 0;
  if (covered >= COMMENT_COVERAGE_CAP) {
    console.log(`Comments: coverage ${covered} reached cap ${COMMENT_COVERAGE_CAP}, skip fetching.`);
    return { inherited, fetched, covered };
  }

  try {
    await getWbiKeys(emptyJar);
    console.log('Comments: wbi keys ready (no cookie)');
  } catch (err) {
    console.warn(`Comments: wbi failed (${err.message}), will try unsigned`);
  }

  const budget = Math.min(COMMENT_FETCH_PER_RUN, COMMENT_COVERAGE_CAP - covered);
  const todo = missing.slice(0, budget);
  console.log(`Comments: fetching for ${todo.length} videos...`);

  for (let i = 0; i < todo.length; i += 1) {
    const item = todo[i];
    const comments = await fetchCommentsForBvid(item.bvid, emptyJar);
    item.comments = comments;
    if (comments.length) { fetched += 1; covered += 1; }
    if ((i + 1) % 25 === 0) {
      console.log(`Comments: progress ${i + 1}/${todo.length} (ok ${fetched})`);
    }
    await sleep(COMMENT_DELAY_MIN, COMMENT_DELAY_MAX);
  }

  console.log(`Comments: done. fetched ${fetched}, total covered ${covered}.`);
  return { inherited, fetched, covered };
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function isBlocked(title) {
  const text = String(title || '').toLowerCase();
  return BLOCK_WORDS.some(word => text.includes(word.toLowerCase()));
}

function isVertical(video) {
  return Number(video.height || 0) > Number(video.width || 0);
}

function validVideo(video) {
  if (!video || !video.bvid || !video.title) return false;
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(video.bvid))) return false;
  if (isBlocked(video.title)) return false;
  const duration = Number(video.duration || 0);
  if (duration > 1500) return false;
  if (duration > 0 && duration < 12) return false;
  return true;
}

// B 站返回的 pic 是 http；页面侧统一转 https，避免混合内容被拦。
// pic 用于前端视频号播放器的"封面垫底层"：iframe 渲染出首帧前顶着画面，消除黑闪。
function toHttpsPic(pic) {
  const s = String(pic || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  if (/^\/\//.test(s)) return 'https:' + s;
  return '';
}

function normalizeVideo(raw, keyword) {
  const dimension = raw.dimension || {};
  const stat = raw.stat || {};
  const owner = raw.owner || {};
  const width = Number(raw.width || dimension.width || 0);
  const height = Number(raw.height || dimension.height || 0);
  const face = String(raw.face || owner.face || '').trim();
  const likeCount = Number(raw.likeCount || stat.like || 0);
  const view = Number(raw.view || stat.view || stat.vv || 0);
  return {
    bvid: String(raw.bvid || '').trim(),
    title: cleanText(raw.title),
    author: cleanText(raw.author || owner.name) || keyword,
    face,
    pic: toHttpsPic(raw.pic || raw.cover || raw.pic_url || ''),
    keyword: cleanText(raw.keyword || keyword),
    likes: String(raw.likes || likeCount || view || 50),
    likeCount,
    view,
    coin: Number(raw.coin || stat.coin || 0),
    favorite: Number(raw.favorite || stat.favorite || 0),
    share: Number(raw.share || stat.share || 0),
    reply: Number(raw.reply || stat.reply || 0),
    duration: Number(raw.duration || 0),
    width,
    height,
    vertical: height > width,
    location: cleanText(raw.location || raw.pub_location || ''),
    addedAt: raw.addedAt || new Date().toISOString()
  };
}

function normalizeList(list, keyword) {
  return (Array.isArray(list) ? list : [])
    .map(item => normalizeVideo(item, keyword))
    .filter(validVideo);
}

function mergePool(existing, incoming) {
  const map = new Map();
  normalizeList(existing, '库存').forEach(item => map.set(item.bvid, item));
  normalizeList(incoming, '新增').forEach(item => {
    const old = map.get(item.bvid);
    map.set(item.bvid, Object.assign({}, old || {}, item, { addedAt: (old && old.addedAt) || item.addedAt }));
  });
  return Array.from(map.values()).sort((a, b) => {
    if (a.vertical !== b.vertical) return a.vertical ? -1 : 1;
    return Number(b.likes || 0) - Number(a.likes || 0);
  }).slice(0, POOL_TARGET);
}

function pickFeed(pool, history) {
  const recent = new Set(history.map(entry => entry.bvid));
  const vertical = [];
  const horizontal = [];
  pool.forEach(item => (isVertical(item) ? vertical : horizontal).push(item));
  const preferred = vertical.concat(horizontal);
  const fresh = preferred.filter(item => !recent.has(item.bvid));
  const recycled = preferred.filter(item => recent.has(item.bvid));
  return fresh.concat(recycled).slice(0, FEED_SIZE);
}

function trimHistory(history) {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return (history || []).filter(entry => Date.parse(entry.date) >= cutoff);
}

function savePool(pool, source) {
  const now = new Date().toISOString();
  const verticalCount = pool.filter(isVertical).length;
  const horizontalCount = pool.length - verticalCount;
  writeJson(POOL_FILE, {
    generatedAt: now,
    poolTarget: POOL_TARGET,
    total: pool.length,
    verticalCount,
    horizontalCount,
    lastSource: source,
    items: pool
  });
  return { verticalCount, horizontalCount };
}

async function collectFromSource(name, factory, cookieJar) {
  const items = [];
  try {
    for await (const chunk of factory(cookieJar)) {
      items.push(...chunk);
      console.log(`${name}: +${chunk.length} (source total ${items.length})`);
      await sleep(DELAY_MIN_MS, DELAY_MAX_MS);
    }
  } catch (err) {
    if (err.riskControl) console.warn(`${name} stopped by risk control: ${err.message}`);
    else console.warn(`${name}: ${err.message}`);
  }
  return items;
}

async function* popularSource(cookieJar) {
  for (let pn = 1; pn <= POPULAR_PAGES; pn += 1) {
    const url = `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`;
    const json = await requestJson(url, cookieJar);
    const list = (json && json.data && json.data.list) || [];
    const items = normalizeList(list, '热门');
    if (!items.length) break;
    yield items;
  }
}

async function* preciousSource(cookieJar) {
  for (let page = 1; page <= PRECIOUS_PAGES; page += 1) {
    const url = `https://api.bilibili.com/x/web-interface/popular/precious?page_size=100&page=${page}`;
    const json = await requestJson(url, cookieJar);
    const list = (json && json.data && json.data.list) || [];
    const items = normalizeList(list, '每周必看');
    if (!items.length) break;
    yield items;
  }
}

async function main() {
  const now = new Date().toISOString();
  const oldFeed = readJson(FEED_FILE, { items: [] });
  const oldPoolFile = readJson(POOL_FILE, { items: [] });
  const history = trimHistory(readJson(HISTORY_FILE, []));

  let pool = mergePool(
    normalizeList(FALLBACK_ITEMS, '备用视频'),
    normalizeList((oldPoolFile.items || []).concat(oldFeed.items || []), '旧库存')
  );
  savePool(pool, 'seed');
  console.log(`Seed pool ${pool.length} (${pool.filter(isVertical).length} vertical).`);

  let cookieJar = '';
  try {
    cookieJar = await warmupCookies();
    console.log(`Cookie warmup ok (${cookieJar.split(';').length} entries).`);
  } catch (err) {
    console.warn(`Cookie warmup failed: ${err.message}`);
  }

  const sources = [
    { name: 'popular', factory: popularSource },
    { name: 'precious', factory: preciousSource }
  ];

  for (const source of sources) {
    const collected = await collectFromSource(source.name, source.factory, cookieJar);
    if (!collected.length) continue;
    pool = mergePool(pool, collected);
    const stats = savePool(pool, source.name);
    console.log(`After ${source.name}: pool=${pool.length} vertical=${stats.verticalCount} horizontal=${stats.horizontalCount}`);
    await sleep(DELAY_MIN_MS, DELAY_MAX_MS);
  }

  const feedItems = pickFeed(pool, history);
  const verticalCount = pool.filter(isVertical).length;
  const horizontalCount = pool.length - verticalCount;

  // 评论：先继承上一轮，再给靠前的若干条补抓（远程 feed 以前完全没有评论）
  const commentStats = await buildComments(feedItems, oldFeed, cookieJar);

  writeJson(FEED_FILE, {
    date: now.slice(0, 10),
    source: 'video-pool',
    generatedAt: now,
    poolSize: pool.length,
    verticalCount,
    horizontalCount,
    commentCoverage: commentStats.covered,
    commentInherited: commentStats.inherited,
    commentFetched: commentStats.fetched,
    items: feedItems
  });

  const nextHistory = history.concat(feedItems.map(item => ({ bvid: item.bvid, date: now })));
  writeJson(HISTORY_FILE, nextHistory);

  console.log(`Final pool ${pool.length} (${verticalCount} vertical, ${horizontalCount} horizontal); feed ${feedItems.length}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
