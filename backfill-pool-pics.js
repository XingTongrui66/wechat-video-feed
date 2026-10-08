/* 给 video-feed 仓库的存量数据补 B 站封面（pic）：video-pool.json + channels-feed.json */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const CACHE = path.join(ROOT, 'pic-cache.json');
const FILES = ['data/video-pool.json', 'data/channels-feed.json'];
const CONC = 3;
const GAP = 120;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*'
};

function toHttpsPic(pic) {
  const s = String(pic || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  if (/^\/\//.test(s)) return 'https:' + s;
  return '';
}

let lastReq = 0;
function fetchView(bvid, tries) {
  tries = tries || 3;
  return new Promise(resolve => {
    let attempt = 0;
    function go() {
      const wait = Math.max(0, lastReq + GAP - Date.now());
      lastReq = Date.now() + wait;
      setTimeout(() => {
        const req = https.get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { headers: HEADERS }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', c => { body += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(body);
              const pic = j && j.data && toHttpsPic(j.data.pic);
              if (pic) return resolve(pic);
            } catch (_) {}
            retry();
          });
        });
        req.on('error', retry);
        req.setTimeout(15000, () => { req.destroy(); retry(); });
      }, wait);
    }
    function retry() {
      attempt += 1;
      if (attempt >= tries) return resolve('');
      setTimeout(go, 800 * attempt);
    }
    go();
  });
}

(async function main() {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const datasets = FILES.map(f => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    return { f, j, items: j.items || [] };
  });

  // 全局待补队列（去重：同一 bvid 只查一次）
  const seen = new Set();
  const queue = [];
  for (const d of datasets) {
    for (const it of d.items) {
      if (!it || !it.bvid || it.pic || seen.has(it.bvid)) continue;
      seen.add(it.bvid);
      queue.push(it.bvid);
    }
  }
  console.log('待补封面 bvid:', queue.length);

  let done = 0, hit = 0;
  const q = queue.slice();
  async function worker() {
    while (q.length) {
      const bvid = q.shift();
      if (!bvid) continue;
      if (cache[bvid]) { hit += 1; }
      else {
        const pic = await fetchView(bvid);
        if (pic) { cache[bvid] = pic; hit += 1; }
      }
      done += 1;
      if (done % 200 === 0) {
        console.log(`  ...${done}/${queue.length} (命中 ${hit})`);
        fs.writeFileSync(CACHE, JSON.stringify(cache));
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`查询完成: 命中 ${hit}/${queue.length}`);

  // 回写
  for (const d of datasets) {
    let added = 0;
    for (const it of d.items) {
      if (it && it.bvid && !it.pic && cache[it.bvid]) { it.pic = cache[it.bvid]; added += 1; }
    }
    d.j.items = d.items;
    fs.writeFileSync(path.join(ROOT, d.f), JSON.stringify(d.j));
    const left = d.items.filter(it => it && it.bvid && !it.pic).length;
    console.log(`[${d.f}] +${added} 封面，仍缺 ${left}`);
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
