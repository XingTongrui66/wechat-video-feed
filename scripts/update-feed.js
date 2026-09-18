#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'channels-feed.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'channels-history.json');
const TARGET_TOTAL = 60;
const PER_CATEGORY_LIMIT = 8;
const HISTORY_DAYS = 7;

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
  { bvid: 'BV1xx411c7mD', title: '字幕君交流场所', author: '碧诗', keyword: '备用视频', likes: '128' },
  { bvid: 'BV1GJ411x7h7', title: 'Never Gonna Give You Up', author: '官方 MV', keyword: '备用视频', likes: '96' },
  { bvid: 'BV1Q5411c7mD', title: '杨紫方言传话要崩溃', author: '影视精选', keyword: '备用视频', likes: '74' }
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

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function isBlocked(title) {
  const text = String(title || '').toLowerCase();
  return BLOCK_WORDS.some(word => text.includes(word.toLowerCase()));
}

function validVideo(video) {
  if (!video || !video.bvid || !video.title) return false;
  if (String(video.bvid).indexOf('BV') !== 0) return false;
  if (isBlocked(video.title)) return false;
  if (Number(video.duration || 0) > 900) return false;
  if (Number(video.duration || 0) > 0 && Number(video.duration || 0) < 20) return false;
  return true;
}

function normalizeVideo(raw, keyword) {
  return {
    bvid: raw.bvid,
    title: cleanText(raw.title),
    author: cleanText(raw.owner && raw.owner.name) || keyword,
    keyword,
    likes: String(raw.stat && raw.stat.like ? raw.stat.like : raw.stat && raw.stat.view ? raw.stat.view : 50),
    duration: Number(raw.duration || 0)
  };
}

async function fetchCategory(category) {
  const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${category.rid}&type=all`;
  const json = await requestJson(url);
  const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
  return list.map(item => normalizeVideo(item, category.keyword)).filter(validVideo);
}

function trimHistory(history) {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return (history || []).filter(entry => Date.parse(entry.date) >= cutoff);
}

async function main() {
  const history = trimHistory(readJson(HISTORY_FILE, []));
  const used = new Set(history.map(entry => entry.bvid));
  const items = [];

  for (const category of RANKING_CATEGORIES) {
    try {
      const found = await fetchCategory(category);
      let added = 0;
      for (const item of found) {
        if (items.length >= TARGET_TOTAL || added >= PER_CATEGORY_LIMIT) break;
        if (used.has(item.bvid)) continue;
        used.add(item.bvid);
        items.push(item);
        added += 1;
      }
      console.log(`${category.keyword}: ${found.length} candidates, added ${added}, total ${items.length}`);
    } catch (err) {
      console.warn(`${category.keyword}: ${err.message}`);
    }
  }

  if (items.length < 12) {
    const old = readJson(OUT_FILE, null);
    if (old && Array.isArray(old.items) && old.items.length) {
      console.warn(`Only ${items.length} new items. Keeping previous feed.`);
      return;
    }
    items.push(...FALLBACK_ITEMS);
  }

  const now = new Date();
  const feed = {
    date: now.toISOString().slice(0, 10),
    source: 'bilibili-ranking',
    generatedAt: now.toISOString(),
    items: items.slice(0, TARGET_TOTAL)
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(feed, null, 2) + '\n', 'utf8');

  const nextHistory = history.concat(feed.items.map(item => ({ bvid: item.bvid, date: feed.generatedAt })));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(nextHistory, null, 2) + '\n', 'utf8');
  console.log(`Generated ${feed.items.length} videos into ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
