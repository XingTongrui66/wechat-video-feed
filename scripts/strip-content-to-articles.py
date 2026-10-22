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
import hashlib
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scripts/.. = virtual-wechat
DATA = os.path.join(BASE, "data")
ART_DIR = os.path.join(DATA, "articles")
os.makedirs(ART_DIR, exist_ok=True)

STRIP_KEYS = ("content", "body")

# 权威上传清单 {id: sha1前16位}：只有 COS 返回 200 后才由上传脚本写入。
UPLOADED_PATH = os.path.join(DATA, "articles-uploaded.json")

def load_uploaded():
    """清单缺失/损坏/非 dict 时视为空清单，不崩溃。"""
    try:
        with open(UPLOADED_PATH, encoding="utf-8") as f:
            u = json.load(f)
        if isinstance(u, dict):
            return u
    except FileNotFoundError:
        pass
    except Exception as e:
        sys.stderr.write(f"[warn] articles-uploaded.json 损坏，按空清单处理: {e}\n")
    return {}

def payload_bytes(payload):
    """确定性序列化（sort_keys），落盘字节即哈希字节。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")

def payload_sha(b):
    return hashlib.sha1(b).hexdigest()[:16]

# ---------------------------------------------------------------------------
# 密钥脱敏：单篇正文里若混入形如 API key 的字符串（例：某篇文章贴了
# Stripe / GitHub / AWS 密钥样例），会把 GitHub 仓库的 Push Protection
# 触发，导致 CI 的 git push 被 GH013 拒。写单篇前把这些"密钥形"字符串
# 替换为 [REDACTED]，让文章可读但不再触发 secret scanning。
# 这是最小化脱敏：只命中高置信度的密钥前缀，避免误伤正文。
# ---------------------------------------------------------------------------
_SECRET_PATTERNS = [
    r"sk_(live|test)_[A-Za-z0-9]{20,}",       # Stripe
    r"ghp_[A-Za-z0-9]{30,}",                  # GitHub PAT (classic)
    r"gho_[A-Za-z0-9]{30,}",
    r"ghs_[A-Za-z0-9]{30,}",
    r"ghu_[A-Za-z0-9]{30,}",
    r"github_pat_[A-Za-z0-9_]{20,}",          # GitHub PAT (fine-grained)
    r"AKIA[A-Z0-9]{16}",                      # AWS access key id
    r"AIza[A-Za-z0-9_-]{35}",                 # Google API key
    r"xox[bpars]-[A-Za-z0-9-]{10,}",          # Slack token
    r"AKID[A-Za-z0-9]{20,}",                  # 腾讯云 secret id
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",    # PEM 私有密钥
]
_SECRET_RE = re.compile("|".join(f"({p})" for p in _SECRET_PATTERNS))

def redact_secrets(text):
    """把文本里形如密钥的子串替换为 [REDACTED]。仅作用于字符串值。"""
    if not isinstance(text, str):
        return text
    return _SECRET_RE.sub("[REDACTED]", text)

def deep_redact(o):
    if isinstance(o, str):
        return redact_secrets(o)
    if isinstance(o, dict):
        return {k: deep_redact(v) for k, v in o.items()}
    if isinstance(o, list):
        return [deep_redact(v) for v in o]
    return o

# 清理孤立 UTF-16 代理（\ud800-\udfff），避免 json.dump(ensure_ascii=False)
# 写 utf-8 文件时 UnicodeEncodeError（源 RSS 偶有截断表情残骸）。
_SURR_RE = re.compile(r"[\ud800-\udfff]")

def deep_clean(o):
    if isinstance(o, str):
        return _SURR_RE.sub("", o)
    if isinstance(o, dict):
        return {k: deep_clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [deep_clean(v) for v in o]
    return o


def strip_feed(fname, changed_ids, uploaded):
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
                    # 脱敏密钥形字符串，避免 GitHub Push Protection 拒推
                    payload = deep_redact(payload)
                    # 清理孤立 UTF-16 代理（避免 ensure_ascii=False 写文件崩溃）
                    payload = deep_clean(payload)
                    try:
                        raw = payload_bytes(payload)
                        with open(os.path.join(ART_DIR, f"{cid}.json"), "wb") as f:
                            f.write(raw)
                        stripped += 1
                        # 仅当清单里没有该 id 或哈希不同才需要上传
                        if uploaded.get(str(cid)) != payload_sha(raw):
                            changed_ids.add(str(cid))
                    except Exception as e:
                        failed += 1
                        sys.stderr.write(f"[err] 写 articles/{cid}.json 失败: {e}\n")
                # 剥离正文（列表展示不需要）
                for k in STRIP_KEYS:
                    art.pop(k, None)
    # 写回（压缩单行，前端解析无影响；体积更小）
    # 同样对列表 JSON 做脱敏 + 清代理，避免 official-feed/look-feed 也触发 Push Protection
    d = deep_redact(d)
    d = deep_clean(d)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)
    after = os.path.getsize(p)
    print(f"{fname}: 文章={total} 剥离正文={stripped} 失败={failed} | "
          f"{before/1048576:.1f}MB -> {after/1048576:.1f}MB (省 {(1-after/before)*100:.0f}%)")


if __name__ == "__main__":
    changed = set()
    uploaded = load_uploaded()
    for fn in ("look-feed.json", "official-feed.json"):
        strip_feed(fn, changed, uploaded)
    # 写增量清单：本轮新生成/变更的单篇 id（CI 的 COS 上传步骤读它做增量，避免全量 1700 篇超时）
    changed_path = os.path.join(DATA, "articles-changed.txt")
    with open(changed_path, "w", encoding="utf-8") as f:
        for cid in sorted(changed):
            f.write(cid + "\n")
    print(f"\n本轮变更单篇（相对上传清单）: {len(changed)} 个 -> data/articles-changed.txt")
    # 统计 articles 目录
    cnt = len([x for x in os.listdir(ART_DIR) if x.endswith(".json")])
    sz = sum(os.path.getsize(os.path.join(ART_DIR, x)) for x in os.listdir(ART_DIR) if x.endswith(".json"))
    print(f"data/articles/: {cnt} 个小文件, 合计 {sz/1048576:.1f}MB（按需下载，不进列表流量）")
