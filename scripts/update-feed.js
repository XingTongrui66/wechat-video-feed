/*
 * 视频号素材抓取脚本：从 B站抓取最新“竖屏”热门视频，生成 data/channels-feed.json。
 * 由 CI（.github/workflows/update-feed.yml）每日定时运行，实现素材“每天自动更新”。
 * 也可在本地运行：node scripts/update-feed.js
 *
 * 生成的数据结构需与前端 scripts/views/channels.js 的 normalizeFeed 兼容：
 *   items[].bvid 必须是 BV + 10 位字符，否则前端会丢弃。
 *   items[].vertical / width / height 会被前端用来把视频号渲染成竖屏（9:16）样式。
 *
 * 竖屏判定：height >= width 且带明确尺寸。ranking / popular 列表本身不含尺寸，
 * 需要再用“视频详情(view)”接口取 dimension 才能判断横竖。
 *
 * 来源策略（两个都带重试，谁先凑够竖屏用谁）：
 *   1) popular（带 web_location + wbi 签名）—— 列表自带 dimension，最干净；CI/正常网络用。
 *   2) ranking + view 兜底 —— popular 被某些 IP 风控(-400)时，用排行榜凑候选，
 *      再逐条查 view 拿 dimension 筛竖屏。两个接口在本机都不风控，稳定可用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FEED_PATH = path.join(DATA_DIR, 'channels-feed.json');
const HISTORY_PATH = path.join(DATA_DIR, 'channels-history.json');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*'
};

// B 站返回的 pic 是 http，页面是 https（GitHub Pages / 本地 file 混合场景）会拦混合内容，统一转 https
function toHttpsPic(pic) {
  const s = String(pic || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  if (/^\/\//.test(s)) return 'https:' + s;
  return '';
}

const TARGET = 200;            // 每轮抓取的竖屏视频候选上限（用户要求约每天 200 新视频）
const MIN_VERTICAL = 8;        // 至少要有这么多竖屏，否则视为抓取异常，保留旧 feed
const POPULAR_PAGES = 3;       // popular 最多翻几页
const VIEW_BUDGET = 800;      // 候选数量（原 220 只筛出 56 竖屏；放大到 800，预计 250+ 竖屏）
const VIEW_DELAY = 40;        // view 详情间隔(ms)，预算放大时调小避免总耗时过长
const PAGE_DELAY = 2000;       // popular 翻页间隔(ms)

// ---- 评论增量累积 ----
const REMOTE_FEED_URL = process.env.REMOTE_FEED_URL || 'https://xingtongrui66.github.io/wechat-video-feed/data/channels-feed.json';
const COMMENT_BATCH = Math.max(0, parseInt(process.env.COMMENT_BATCH || '300', 10) || 0); // 每轮最多给多少个“无评论”视频补评论
const COMMENT_TARGET = 80;     // 每视频评论上限
const COMMENT_PS = 20;
const COMMENT_DELAY = 200;     // 评论请求间隔(ms)
const COMMENT_FAIL_ABORT = 8;  // 连续失败达到该值仅做告警（不再整轮放弃，避免评论永久缺失）
const FEED_MAX = Math.max(1, parseInt(process.env.FEED_MAX || '500', 10) || 500); // 视频池上限 500，超出按先进先出(FIFO)淘汰最旧视频
const FEED_OUT_PATH = process.env.FEED_OUT || FEED_PATH;          // 冒烟测试可指向临时文件
const HISTORY_OUT_PATH = process.env.HISTORY_OUT || HISTORY_PATH;

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

let _wbiKeys = null;

function fetchJson(url, tries) {
  tries = tries || 2;
  return new Promise(function (resolve, reject) {
    let attempt = 0;
    function go() {
      const req = https.get(
        url,
        { headers: HEADERS },
        function (res) {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return resolve(fetchJson(res.headers.location, tries));
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', function (c) { body += c; });
          res.on('end', function () {
            try { resolve(JSON.parse(body)); } catch (e) { retry(new Error('JSON parse failed: ' + e.message)); }
          });
        }
      );
      req.on('error', function (e) { retry(e); });
      req.setTimeout(15000, function () { req.destroy(new Error('request timeout')); });
    }
    function retry(err) {
      attempt += 1;
      if (attempt >= tries) return reject(err);
      console.warn('[update-feed] retry ' + attempt + ' -', err.message);
      setTimeout(go, 1200 * attempt);
    }
    go();
  });
}

async function getWbiKeys() {
  if (_wbiKeys) return _wbiKeys;
  const resp = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const wbi = resp && resp.data && resp.data.wbi_img;
  if (!wbi) throw new Error('no wbi_img in nav');
  const imgKey = String(wbi.img_url || '').split('/').pop().split('.')[0];
  const subKey = String(wbi.sub_url || '').split('/').pop().split('.')[0];
  const orig = imgKey + subKey;
  let mixin = '';
  for (const i of MIXIN_KEY_ENC_TAB) mixin += orig[i] || '';
  mixin = mixin.slice(0, 32);
  _wbiKeys = { mixin: mixin };
  return _wbiKeys;
}

function signQuery(params) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const keys = Object.keys(p).sort();
  const qs = keys.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); }).join('&');
  if (!_wbiKeys) return qs;
  const w_rid = crypto.createHash('md5').update(qs + _wbiKeys.mixin).digest('hex');
  return qs + '&w_rid=' + w_rid;
}

function buildUrl(base, params) {
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  return base + sep + signQuery(params);
}

// ---- 读取上一轮已发布的 feed（本地 → CI 下再拉远程；失败一律降级为空） ----
function readLocalFeed() {
  try { return JSON.parse(fs.readFileSync(process.env.FEED_PRIOR || FEED_PATH, 'utf8')); }
  catch (e) { return null; }
}

function fetchPriorRemote(url, redirects) {
  return new Promise(function (resolve) {
    try {
      const req = https.get(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 3) {
          res.resume();
          return resolve(fetchPriorRemote(new URL(res.headers.location, url).toString(), (redirects || 0) + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { body += c; });
        res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
      });
      req.on('error', function () { resolve(null); });
      req.setTimeout(10000, function () { req.destroy(); });
    } catch (e) { resolve(null); }
  });
}

function normalizeComments(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !String(c.text || '').trim()) continue;
    out.push({
      name: String(c.name || ''),
      avatar: String(c.avatar || ''),
      text: String(c.text),
      like: Number(c.like || 0),
      time: Number(c.time || 0)
    });
    if (out.length >= COMMENT_TARGET) break;
  }
  return out;
}

// 返回 Map<bvid, item>（评论已 normalize）；同一 bvid 取评论更多者。含无评论的旧视频，用于以上一轮 feed 为基底累积
async function loadPrior() {
  const feeds = [readLocalFeed()];
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.NO_REMOTE_PRIOR !== '1') {
    const remote = await fetchPriorRemote(REMOTE_FEED_URL);
    console.log('[update-feed] remote prior feed: ' + (remote ? 'ok (' + (Array.isArray(remote.items) ? remote.items.length : 0) + ' items)' : 'unavailable, fallback to local'));
    feeds.push(remote);
  }
  const items = new Map();
  for (const f of feeds) {
    for (const it of (f && Array.isArray(f.items) ? f.items : [])) {
      const bvid = it && String(it.bvid || '');
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
      const cm = normalizeComments(it.comments);
      const cur = items.get(bvid);
      if (!cur || cm.length > cur.comments.length) {
        const merged = Object.assign({}, it, { comments: cm });
        if (cur && cur.commentsTriedAt && !merged.commentsTriedAt) merged.commentsTriedAt = cur.commentsTriedAt;
        items.set(bvid, merged);
      }
    }
  }
  return items;
}
function extractItems(resp) {
  if (!resp || resp.code !== 0) return [];
  if (Array.isArray(resp.data)) return resp.data;
  if (resp.data && Array.isArray(resp.data.item)) return resp.data.item;
  if (resp.data && Array.isArray(resp.data.list)) return resp.data.list;
  return [];
}

function dimVertical(dim) {
  const w = Number(dim && dim.width || 0);
  const h = Number(dim && dim.height || 0);
  return (w > 0 && h > 0) ? (h >= w) : false;
}

// 路径 1：popular（列表自带 dimension，直接筛竖屏）
async function collectFromPopular() {
  const out = [];
  const seen = new Set();
  for (let pn = 1; pn <= POPULAR_PAGES; pn++) {
    if (out.length >= TARGET) break;
    const url = buildUrl('https://api.bilibili.com/x/web-interface/popular', { ps: 100, pn: pn, web_location: '333.1007' });
    try {
      const resp = await fetchJson(url);
      const raw = extractItems(resp);
      if (!raw.length) { console.warn('[update-feed] popular pn=' + pn + ' empty (code=' + (resp && resp.code) + ')'); continue; }
      for (const v of raw) {
        if (out.length >= TARGET) break;
        const bvid = String(v.bvid || '').trim();
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
        if (!dimVertical(v.dimension)) continue;
        if (seen.has(bvid)) continue;
        seen.add(bvid);
        const dim = v.dimension || {};
        const stat = v.stat || {};
        const owner = v.owner || {};
        out.push({
          bvid: bvid,
          title: String(v.title || '视频').trim(),
          author: String(owner.name || 'B站').trim(),
          face: String(owner.face || ''),
          // 封面：切换/首播时垫在播放器下面，避免 iframe 渲染前的黑屏空档
          pic: toHttpsPic(v.pic),
          likeCount: Number(stat.like || 0),
          favorite: Number(stat.favorite || 0),
          share: Number(stat.share || 0),
          reply: Number(stat.reply || 0),
          coin: Number(stat.coin || 0),
          view: Number(stat.view || 0),
          duration: Number(v.duration || 0),
          width: Number(dim.width || 0),
          height: Number(dim.height || 0),
          vertical: true,
          addedAt: new Date().toISOString()
        });
      }
      console.log('[update-feed] popular pn=' + pn + ' -> vertical so far: ' + out.length);
    } catch (e) {
      console.warn('[update-feed] popular pn=' + pn + ' failed -', e.message);
    }
    if (pn < POPULAR_PAGES) await new Promise(function (r) { setTimeout(r, PAGE_DELAY); });
  }
  return out;
}

// 路径 2：ranking 凑候选 bvid，再逐条 view 拿 dimension 筛竖屏（popular 被风控时兜底）
async function collectFromRanking() {
  const seen = new Set();
  const cand = [];
  const sources = [
    'https://api.bilibili.com/x/web-interface/ranking?day=3',
    'https://api.bilibili.com/x/web-interface/ranking?day=2',
    'https://api.bilibili.com/x/web-interface/ranking?day=1',
    'https://api.bilibili.com/x/web-interface/ranking/region?rid=160&day=3', // 生活
    'https://api.bilibili.com/x/web-interface/ranking/region?rid=206&day=3', // 美食
    'https://api.bilibili.com/x/web-interface/ranking/region?rid=129&day=3', // 舞蹈
    'https://api.bilibili.com/x/web-interface/ranking/region?rid=159&day=3'  // 时尚
  ];
  for (const u of sources) {
    if (cand.length >= VIEW_BUDGET) break;
    try {
      const resp = await fetchJson(u);
      const list = extractItems(resp);
      for (const v of list) {
        const b = String(v.bvid || '').trim();
        if (/^BV[0-9A-Za-z]{10}$/.test(b) && !seen.has(b)) { seen.add(b); cand.push(b); }
        if (cand.length >= VIEW_BUDGET) break;
      }
      console.log('[update-feed] ranking src -> candidates ' + cand.length);
    } catch (e) {
      console.warn('[update-feed] ranking src failed -', e.message);
    }
  }

  const out = [];
  let checked = 0;
  for (const b of cand) {
    if (out.length >= TARGET) break;
    checked += 1;
    try {
      const r = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + b);
      const d = r && r.data;
      if (!d) continue;
      const dim = d.dimension || {};
      if (!dimVertical(dim)) continue; // 只收竖屏
      const owner = d.owner || {};
      const stat = d.stat || {};
      out.push({
        bvid: b,
        title: String(d.title || '视频').trim(),
        author: String(owner.name || 'B站').trim(),
        face: String(owner.face || ''),
        pic: toHttpsPic(d.pic),
        likeCount: Number(stat.like || 0),
        favorite: Number(stat.favorite || 0),
        share: Number(stat.share || 0),
        reply: Number(stat.reply || 0),
        coin: Number(stat.coin || 0),
        view: Number(stat.view || 0),
        duration: Number(d.duration || 0),
        width: Number(dim.width || 0),
        height: Number(dim.height || 0),
        vertical: true,
        addedAt: new Date().toISOString()
      });
    } catch (e) { /* 单条失败忽略，继续 */ }
    if (VIEW_DELAY) await new Promise(function (r) { setTimeout(r, VIEW_DELAY); });
  }
  console.log('[update-feed] ranking->view checked ' + checked + ' -> vertical ' + out.length);
  return out;
}

async function main() {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8') || '[]'); } catch (e) { history = []; }
  const seenHist = new Set(history);

  try { await getWbiKeys(); console.log('[update-feed] wbi keys ready'); }
  catch (e) { console.warn('[update-feed] wbi failed (will try unsigned):', e.message); }

  let collected = await collectFromPopular();
  let viaPopular = collected.length >= MIN_VERTICAL;
  if (!viaPopular) {
    console.log('[update-feed] popular 不足，改用 ranking+view 兜底');
    collected = await collectFromRanking();
  }

  if (collected.length < MIN_VERTICAL) {
    console.error('[update-feed] only ' + collected.length + ' vertical (need >= ' + MIN_VERTICAL + '). Keep existing feed unchanged.');
    process.exit(1);
  }

  // 新内容优先排在前面
  let chosen = collected.map(function (it) {
    return Object.assign({}, it, { repeat: seenHist.has(it.bvid) });
  }).sort(function (a, b) { return (a.repeat ? 1 : 0) - (b.repeat ? 1 : 0); });

  // ---------- 为每个视频抓取热门评论（wbi/main 游标翻页，目标 80 条） ----------
  // 旧接口 x/v2/reply 无签名只吐 3 条热门；改用 x/v2/reply/wbi/main（需 wbi 签名 +
  // next 游标翻页）每页稳定 20 条，4 页 = 80 条。响应结构：data.replies + data.cursor.next/is_end。
  async function fetchCommentsForBvid(bvid) {
    // 先拿 aid
    let aid = 0;
    try {
      const vr = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
      aid = (vr && vr.data && vr.data.aid) || 0;
    } catch (e) { return []; }
    if (!aid) return [];

    const allReplies = [];
    let next = 0; // cursor.next：0 表示第一页
    let guard = 0;
    try { await getWbiKeys(); } catch (e) { /* 无签名也试一次 */ }
    for (let page = 0; page < Math.ceil(COMMENT_TARGET / COMMENT_PS) + 2 && allReplies.length < COMMENT_TARGET; page++) {
      if (guard++ > 12) break;
      try {
        const url = buildUrl('https://api.bilibili.com/x/v2/reply/wbi/main', {
          oid: aid, type: 1, mode: 3, next: next, ps: COMMENT_PS, plat: 1, web_location: '1315875'
        });
        const cr = await fetchJson(url);
        const data = cr && cr.data;
        const replies = (data && data.replies) || [];
        if (!replies.length) break;
        for (const c of replies) {
          allReplies.push({
            name: (c.member && c.member.uname) || '',
            avatar: String((c.member && c.member.avatar) || '').replace(/^http:\/\//, 'https://'),
            text: (c.content && c.content.message) || '',
            like: Number(c.like || 0),
            time: Number(c.ctime || 0)
          });
        }
        const cursor = data && data.cursor;
        if (!cursor || cursor.is_end) break;
        next = Number(cursor.next || 0);
        if (!next && !cursor.is_end) break;
      } catch (e) { break; }
      if (COMMENT_DELAY) await new Promise(function (r) { setTimeout(r, COMMENT_DELAY); });
    }
    return allReplies.slice(0, COMMENT_TARGET);
  }

  // ---------- 增量累积 + 视频池 FIFO：继承评论，按先进先出淘汰最旧视频 ----------
  const prior = await loadPrior();
  let inherited = 0;
  // 基底 = 上一轮全部旧视频 + 本轮新采集（同 bvid 覆盖）；重复视频保留首次入库时间，保证 FIFO 正确
  const allMap = new Map(prior);
  for (const it of chosen) {
    const old = prior.get(it.bvid);
    if (old && old.comments.length) { it.comments = old.comments; inherited++; }
    if (old && old.commentsTriedAt) it.commentsTriedAt = old.commentsTriedAt;
    if (old && old.addedAt) it.addedAt = old.addedAt; // 重复视频保留最早 addedAt
    allMap.set(it.bvid, it);
  }
  // 视频池上限 FEED_MAX，先进先出：按 addedAt 升序，超出部分丢弃最先进入池子（最旧）的视频
  const allArr = Array.from(allMap.values()).sort(function (a, b) {
    const ta = a.addedAt || '', tb = b.addedAt || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const dropped = Math.max(0, allArr.length - FEED_MAX);
  const kept = allArr.length - dropped;
  chosen = allArr.slice(dropped).reverse(); // 仅保留最新的 FEED_MAX 个，且按“最新在前”输出供前端直接展示

  // 待补评论：从未尝试过的优先（即本轮新视频），其次失败过里最久没试的，同条件新的优先
  const need = chosen.filter(function (x) { return x.vertical && !(x.comments && x.comments.length); })
    .sort(function (a, b) {
      const aa = a.commentsTriedAt || '', ab = b.commentsTriedAt || '';
      if (!aa !== !ab) return !aa ? -1 : 1;               // 从未尝试过的排最前
      if (aa && ab && aa !== ab) return aa < ab ? -1 : 1;  // 失败过的里最久没试的优先
      const ta = a.addedAt || '', tb = b.addedAt || '';
      return ta > tb ? -1 : ta < tb ? 1 : 0;              // 相同条件下新的优先
    });
  const batch = need.slice(0, COMMENT_BATCH);
  console.log('[update-feed] pool: kept ' + kept + ' dropped ' + dropped + ' (FIFO), total ' + chosen.length + ', comments inherited ' + inherited + ', need ' + need.length + ', fetching ' + batch.length + ' (COMMENT_BATCH=' + COMMENT_BATCH + ')');  let fetched = 0, skipped = 0, failStreak = 0;
  for (let ci = 0; ci < batch.length; ci++) {
    const it = batch[ci];
    let cm = [];
    // 单条失败重试一次（扛瞬时限流）；不再因连错整轮放弃，避免评论永久缺失
    for (let attempt = 0; attempt < 2 && !cm.length; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, 800); });
      try { cm = await fetchCommentsForBvid(it.bvid); } catch (e) { cm = []; }
      cm = normalizeComments(cm);
    }
    if (cm.length) { it.comments = cm; delete it.commentsTriedAt; fetched++; failStreak = 0; }
    else { it.commentsTriedAt = new Date().toISOString(); skipped++; failStreak++; }
    if (failStreak >= COMMENT_FAIL_ABORT) {
      console.warn('[update-feed] ' + failStreak + ' consecutive empty/failed (skip & continue, NOT aborting this round)');
    }
    if ((ci + 1) % 10 === 0) console.log('[update-feed] comments progress: ' + (ci + 1) + '/' + batch.length + ' (fetched ' + fetched + ')');
    if (COMMENT_DELAY) await new Promise(function (r) { setTimeout(r, COMMENT_DELAY); });
  }
  for (const it of chosen) if (!it.comments) it.comments = [];
  console.log('[update-feed] comments done. inherited ' + inherited + ', fetched ' + fetched + ', skipped ' + skipped + ', still-without ' + chosen.filter(function (x) { return !x.comments.length; }).length);

  const result = {
    date: new Date().toISOString().slice(0, 10),
    source: viaPopular ? 'bilibili-popular-vertical' : 'bilibili-ranking-view-vertical',
    generatedAt: new Date().toISOString(),
    poolSize: chosen.length,
    verticalCount: chosen.filter(function (x) { return x.vertical; }).length,
    horizontalCount: 0,
    items: chosen.map(function (x) { var c = Object.assign({}, x); delete c.repeat; return c; })
  };

  fs.writeFileSync(FEED_OUT_PATH, JSON.stringify(result, null, 2));
  const newHistory = Array.from(new Set(history.concat(chosen.map(function (x) { return x.bvid; })))).slice(-3000);
  fs.writeFileSync(HISTORY_OUT_PATH, JSON.stringify(newHistory, null, 2));
  console.log('[update-feed] DONE. wrote ' + chosen.length + ' videos. history size ' + newHistory.length);
}

main().catch(function (e) {
  console.error('[update-feed] FATAL', e && e.message);
  process.exit(1);
});
