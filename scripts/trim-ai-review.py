#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从全量评论库 data/ai-review.json 裁出「当前列表里的文章」的评论，写到指定路径（供上传 COS）。

用法: python3 scripts/trim-ai-review.py <输出路径>

key 规则与 scripts/ai-comments.js / 前端 official.js 一致：
  - 公众号/看一看文章: (account.id || account.name) + '#' + (article.id || article.title)
  - 快讯 breakingPool:  'breaking_pool#' + (article.id || article.title)
注意：输出不能写回 data/ai-review.json——那是 Git 里的全量库，ai-comments.js 靠它做增量。
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")
FEEDS = ("official-feed.json", "look-feed.json")
REVIEW = os.path.join(DATA, "ai-review.json")


def load(path):
    with open(path, encoding="utf-8") as file:
        return json.load(file)


def ident(obj, *fields):
    for field in fields:
        if obj.get(field):
            return str(obj[field])
    return ""


def current_keys(feed):
    keys = []
    for acc in feed.get("accounts") or []:
        for art in acc.get("articles") or []:
            keys.append(ident(acc, "id", "name") + "#" + ident(art, "id", "title"))
    pool = feed.get("breakingPool") or {}
    items = list(pool.get("items") or [])
    breaking = (feed.get("breaking") or {}).get("article")
    if breaking:
        items.append(breaking)
    for art in items:
        keys.append("breaking_pool#" + ident(art, "id", "title"))
    return keys


def main():
    if len(sys.argv) != 2:
        print("usage: trim-ai-review.py <output-path>")
        return 2
    out = os.path.abspath(sys.argv[1])
    if out == os.path.abspath(REVIEW):
        print("refuse to overwrite data/ai-review.json (full library used for incremental generation)")
        return 2
    review = load(REVIEW)
    if not isinstance(review, dict):
        raise ValueError("ai-review.json must be an object")
    keys = []
    for name in FEEDS:
        keys.extend(current_keys(load(os.path.join(DATA, name))))
    keys = list(dict.fromkeys(keys))
    trimmed = {key: review[key] for key in keys if key in review}
    missing = sum(1 for key in keys if not ((review.get(key) or {}).get("comments")))
    body = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(out, "wb") as file:
        file.write(body)
    print(f"[trim-ai-review] full={len(review)} current_articles={len(keys)} kept={len(trimmed)} "
          f"missing_comments={missing} bytes={len(body)} full_bytes={os.path.getsize(REVIEW)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
