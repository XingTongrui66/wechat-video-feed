#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把线上大 JSON（look-feed.json / official-feed.json）里的文章正文（content/body）
剥离出来，单独写成 data/articles/{id}.json 小文件，供详情页按需（点开时）下载。

效果：
  - 列表 JSON 体积大幅瘦身（正文不再预存）→ 列表加载流量从 ~22MB 降到 ~2MB
  - 详情页点开文章时，按 article.id 拉 data/articles/{id}.json（单篇 ~10KB），体验完整
  - 流量费随之砍掉 ~90%；存储费几乎为 0（小文件合计约 11MB）

可重复运行（幂等）：每次都基于当前大 JSON 的 content 重新生成小文件并改写大 JSON。
若某篇已无 content（之前剥离过），则跳过该篇的小文件生成（保留既有小文件）。

用法：
  python scripts/strip-content-to-articles.py
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scripts/.. = virtual-wechat
DATA = os.path.join(BASE, "data")
ART_DIR = os.path.join(DATA, "articles")
os.makedirs(ART_DIR, exist_ok=True)

STRIP_KEYS = ("content", "body")


def strip_feed(fname):
    p = os.path.join(DATA, fname)
    if not os.path.exists(p):
        print(f"[skip] {fname} 不存在")
        return
    d = json.load(open(p, encoding="utf-8"))
    before = os.path.getsize(p)
    total = 0
    stripped = 0
    failed = 0
    if isinstance(d, dict) and "accounts" in d:
        for acc in d.get("accounts", []):
            if not isinstance(acc, dict):
                continue
            for art in acc.get("articles", []) or []:
                if not isinstance(art, dict):
                    continue
                total += 1
                cid = art.get("id")
                content = art.get("content")
                body = art.get("body")
                if (content or body) and cid:
                    payload = {
                        "id": cid,
                        "title": art.get("title"),
                        "url": art.get("url"),
                        "accountName": acc.get("name") or art.get("accountName"),
                        "author": art.get("author"),
                        "date": art.get("date"),
                        "ts": art.get("ts"),
                        "cover": art.get("cover"),
                        "summary": art.get("summary"),
                        "content": content,
                        "body": body,
                    }
                    try:
                        with open(os.path.join(ART_DIR, f"{cid}.json"), "w", encoding="utf-8") as f:
                            json.dump(payload, f, ensure_ascii=False)
                        stripped += 1
                    except Exception as e:
                        failed += 1
                        sys.stderr.write(f"[err] 写 articles/{cid}.json 失败: {e}\n")
                # 剥离正文（列表展示不需要）
                for k in STRIP_KEYS:
                    art.pop(k, None)
    # 写回（压缩单行，前端解析无影响；体积更小）
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)
    after = os.path.getsize(p)
    print(f"{fname}: 文章={total} 剥离正文={stripped} 失败={failed} | "
          f"{before/1048576:.1f}MB -> {after/1048576:.1f}MB (省 {(1-after/before)*100:.0f}%)")


if __name__ == "__main__":
    for fn in ("look-feed.json", "official-feed.json"):
        strip_feed(fn)
    # 统计 articles 目录
    cnt = len([x for x in os.listdir(ART_DIR) if x.endswith(".json")])
    sz = sum(os.path.getsize(os.path.join(ART_DIR, x)) for x in os.listdir(ART_DIR) if x.endswith(".json"))
    print(f"\ndata/articles/: {cnt} 个小文件, 合计 {sz/1048576:.1f}MB（按需下载，不进列表流量）")
