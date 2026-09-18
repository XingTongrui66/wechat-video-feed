#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const FEED_FILE = path.join(ROOT, 'data', 'channels-feed.json');
const POOL_FILE = path.join(ROOT, 'data', 'video-pool.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'channels-history.json');
const POOL_TARGET = 5000;
const FEED_SIZE = 1500;
const HISTORY_DAYS = 30;
const DELAY_MIN_MS = 4000;
const DELAY_MAX_MS = 8000;

const POPULAR_PAGES = 20;
const PRECIOUS_PAGES = 3;
const RANKING_CATEGORIES = [
  { rid: 160, keyword: '生活' },
  { rid: 211, keyword: '美食' },
  { rid: 217, keyword: '动物' },
  { rid: 3,   keyword: '音乐' },
  { rid: 129, keyword: '舞蹈' },
  { rid: 36,  keyword: '知识' },
  { rid: 188, keyword: '科技' },
  { rid: 181, keyword: '影视' },
  { rid: 5,   keyword: '娱乐' },
  { rid: 155, keyword: '时尚' }
];

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

function normalizeVideo(raw, keyword) {
  const dimension = raw.dimension || {};
  const width = Number(raw.width || dimension.width || 0);
  const height = Number(raw.height || dimension.height || 0);
  return {
    bvid: String(raw.bvid || '').trim(),
    title: cleanText(raw.title),
    author: cleanText(raw.author || (raw.owner && raw.owner.name)) || keyword,
    keyword: cleanText(raw.keyword || keyword),
    likes: String(raw.likes || (raw.stat && (raw.stat.like || raw.stat.view)) || 50),
    duration: Number(raw.duration || 0),
    width,
    height,
    vertical: height > width,
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

async function* rankingSource(cookieJar) {
  for (const category of RANKING_CATEGORIES) {
    const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${category.rid}&type=all`;
    const json = await requestJson(url, cookieJar);
    const list = (json && json.data && json.data.list) || [];
    yield normalizeList(list, category.keyword);
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
    { name: 'precious', factory: preciousSource },
    { name: 'ranking', factory: rankingSource }
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

  writeJson(FEED_FILE, {
    date: now.slice(0, 10),
    source: 'video-pool',
    generatedAt: now,
    poolSize: pool.length,
    verticalCount,
    horizontalCount,
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
