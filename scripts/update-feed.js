#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const FEED_FILE = path.join(ROOT, 'data', 'channels-feed.json');
const POOL_FILE = path.join(ROOT, 'data', 'video-pool.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'channels-history.json');
const POOL_TARGET = 3000;
const FEED_SIZE = 1000;
const PER_CATEGORY_LIMIT = 120;
const HISTORY_DAYS = 30;

const RANKING_CATEGORIES = [
  { rid: 160, keyword: '生活' },
  { rid: 211, keyword: '美食' },
  { rid: 217, keyword: '动物' },
  { rid: 3, keyword: '音乐' },
  { rid: 129, keyword: '舞蹈' },
  { rid: 36, keyword: '知识' },
  { rid: 188, keyword: '科技' },
  { rid: 119, keyword: '鬼畜' },
  { rid: 181, keyword: '影视' },
  { rid: 5, keyword: '娱乐' },
  { rid: 4, keyword: '游戏' },
  { rid: 155, keyword: '时尚' }
];

const BLOCK_WORDS = [
  '恐怖', '暴力', '吵架', '整蛊', '擦边', '抽卡', '赌博', '彩票', '性感', '美女',
  '减肥神药', '神药', '保健品', '投资', '荐股', '贷款', '网贷', '直播带货', '带货',
  '速赚', '暴富', '玄学', '算命', '灵异', '血腥', '虎门抽烟', '胆汁'
];

const FALLBACK_ITEMS = [
  { bvid: 'BV1JhZcY9EFN', title: '生活记录精选', author: 'B站', keyword: '备用视频', likes: '1000', duration: 334, width: 1080, height: 1920 },
  { bvid: 'BV1fpZ6YaE47', title: '女儿：爸爸妈妈要结婚啦？', author: '肥娟小吃', keyword: '备用视频', likes: '303567', duration: 202, width: 1440, height: 2560 },
  { bvid: 'BV1AiZEY5Etd', title: '短视频精选', author: 'B站', keyword: '备用视频', likes: '1000', duration: 132, width: 1080, height: 1920 },
  { bvid: 'BV1GWZnYcEsu', title: '父亲的爱，总是无声的。', author: '古泽源', keyword: '备用视频', likes: '398688', duration: 29, width: 2160, height: 3840 }
];

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: 15000
    }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout ${url}`)));
    req.on('error', reject);
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
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
  if (Number(video.duration || 0) > 1200) return false;
  if (Number(video.duration || 0) > 0 && Number(video.duration || 0) < 15) return false;
  return true;
}

function normalizeVideo(raw, keyword) {
  const dimension = raw.dimension || {};
  const width = Number(raw.width || dimension.width || 0);
  const height = Number(raw.height || dimension.height || 0);
  return {
    bvid: String(raw.bvid || '').trim(),
    title: cleanText(raw.title),
    author: cleanText(raw.author || raw.owner && raw.owner.name) || keyword,
    keyword: cleanText(raw.keyword || keyword),
    likes: String(raw.likes || raw.stat && (raw.stat.like || raw.stat.view) || 50),
    duration: Number(raw.duration || 0),
    width,
    height,
    vertical: height > width,
    addedAt: raw.addedAt || new Date().toISOString()
  };
}

function normalizeList(list, keyword) {
  return (Array.isArray(list) ? list : []).map(item => normalizeVideo(item, keyword)).filter(validVideo);
}

async function fetchCategory(category) {
  const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${category.rid}&type=all`;
  const json = await requestJson(url);
  if (!json || json.code !== 0) throw new Error(`Bilibili code ${json && json.code}`);
  const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
  return normalizeList(list, category.keyword);
}

function trimHistory(history) {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return (history || []).filter(entry => Date.parse(entry.date) >= cutoff);
}

function mergePool(existing, incoming) {
  const map = new Map();
  normalizeList(existing, '库存').forEach(item => map.set(item.bvid, item));
  normalizeList(incoming, '新增').forEach(item => {
    const old = map.get(item.bvid);
    map.set(item.bvid, Object.assign({}, old || {}, item, { addedAt: old && old.addedAt || item.addedAt }));
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

async function collectNewItems() {
  const items = [];
  for (const category of RANKING_CATEGORIES) {
    try {
      const found = await fetchCategory(category);
      found.slice(0, PER_CATEGORY_LIMIT).forEach(item => items.push(item));
      console.log(`${category.keyword}: ${found.length} candidates, collected ${items.length}`);
    } catch (err) {
      console.warn(`${category.keyword}: ${err.message}`);
    }
  }
  return items;
}

async function main() {
  const now = new Date().toISOString();
  const oldFeed = readJson(FEED_FILE, { items: [] });
  const oldPoolFile = readJson(POOL_FILE, { items: [] });
  const history = trimHistory(readJson(HISTORY_FILE, []));

  const seed = normalizeList(FALLBACK_ITEMS, '备用视频')
    .concat(normalizeList(oldFeed.items || [], '旧清单'))
    .concat(normalizeList(oldPoolFile.items || [], '库存'));
  const collected = await collectNewItems();
  const pool = mergePool(seed, collected);
  const feedItems = pickFeed(pool, history);

  const feed = {
    date: now.slice(0, 10),
    source: collected.length ? 'bilibili-ranking-pool' : 'video-pool-cache',
    generatedAt: now,
    poolSize: pool.length,
    verticalCount: pool.filter(isVertical).length,
    horizontalCount: pool.filter(item => !isVertical(item)).length,
    items: feedItems
  };

  const poolFile = {
    generatedAt: now,
    poolTarget: POOL_TARGET,
    total: pool.length,
    verticalCount: feed.verticalCount,
    horizontalCount: feed.horizontalCount,
    items: pool
  };

  const nextHistory = history.concat(feedItems.map(item => ({ bvid: item.bvid, date: now })));
  writeJson(POOL_FILE, poolFile);
  writeJson(FEED_FILE, feed);
  writeJson(HISTORY_FILE, nextHistory);

  console.log(`Pool ${pool.length} videos (${feed.verticalCount} vertical, ${feed.horizontalCount} horizontal).`);
  console.log(`Feed ${feedItems.length} videos written to ${path.relative(ROOT, FEED_FILE)}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
