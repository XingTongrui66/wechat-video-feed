#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 data/articles-changed.txt 里列出的单篇 data/articles/{id}.json 增量上传到腾讯 COS。

  - 清单 data/articles-uploaded.json = {"<id>": "<sha1前16位>"}，只有 HTTP 200 后才记入
  - 失败的不入清单，下一轮 strip 脚本会再次把它列入 articles-changed.txt 重试
  - 按文章 ts 降序（最近优先）；墙钟预算到点保存清单并以退出码 0 结束
  - 纯标准库；签名 PUT 沿用原工作流里已验证可用的实现

环境变量：
  COS_SECRET_ID / COS_SECRET_KEY   缺失则跳过（退出 0）
  COS_BUCKET / COS_REGION          默认 vw-data-1311399697 / ap-guangzhou
  COS_ENDPOINT                     覆盖 https://{bucket}.cos.{region}.myqcloud.com（测试用）
  UPLOAD_BUDGET_MINUTES            墙钟预算，默认 25
  UPLOAD_SAVE_EVERY                每成功多少个写一次清单，默认 100
  UPLOAD_FAIL_RATIO                失败数 > 成功数*比例 且 失败>5 时步骤标红，默认 0.5
  ARTICLES_DIR / CHANGED_FILE / UPLOADED_FILE   路径覆盖（测试用）
"""
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART_DIR = os.environ.get("ARTICLES_DIR") or os.path.join(BASE, "data", "articles")
CHANGED = os.environ.get("CHANGED_FILE") or os.path.join(BASE, "data", "articles-changed.txt")
UPLOADED = os.environ.get("UPLOADED_FILE") or os.path.join(BASE, "data", "articles-uploaded.json")

SID = os.environ.get("COS_SECRET_ID", "")
SKEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "vw-data-1311399697")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
ENDPOINT = (os.environ.get("COS_ENDPOINT") or f"https://{BUCKET}.cos.{REGION}.myqcloud.com").rstrip("/")
HOST = urllib.parse.urlparse(ENDPOINT).netloc
BUDGET = float(os.environ.get("UPLOAD_BUDGET_MINUTES") or 25) * 60
SAVE_EVERY = int(os.environ.get("UPLOAD_SAVE_EVERY") or 100)
FAIL_RATIO = float(os.environ.get("UPLOAD_FAIL_RATIO") or 0.5)


def h(k, m):
    return hmac.new(k, m.encode("utf-8"), hashlib.sha256).digest()


def put(key, body, ct="application/json; charset=utf-8"):
    t0 = int(time.time()); kt = f"{t0};{t0+3000}"; dp = time.strftime("%Y-%m-%d", time.gmtime(t0))
    md5 = hashlib.md5(body).hexdigest()
    canon = "PUT/" + key + "/" + chr(10) + f"content-type:{ct};host:{HOST};" + chr(10) + "content-type;host" + chr(10) + md5
    sts = "TC3-HMAC-SHA256" + chr(10) + kt + chr(10) + "/cos/" + dp + "/qcs" + chr(10) + hashlib.sha256(canon.encode()).hexdigest()
    k = h(SKEY.encode(), dp); k = h(k, "cos"); k = h(k, REGION); k = h(k, "qcs")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    auth = f"TC3-HMAC-SHA256 Credential={SID}/{kt}/cos/{dp}/qcs, SignedHeaders=content-type;host, Signature={sig}"
    req = urllib.request.Request(f"{ENDPOINT}/{key}", data=body, method="PUT")
    req.add_header("Content-Type", ct); req.add_header("Host", HOST)
    req.add_header("X-TC-Action", "PutObject"); req.add_header("X-TC-Timestamp", str(t0)); req.add_header("Authorization", auth)
    proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for a in range(4):
        try:
            r = proxy.open(req, timeout=60); return r.status, ""
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")[:200]
        except Exception as e:
            if a == 3: return -1, str(e)[:200]
            time.sleep(2)
    return -1, "retry-exhausted"


def load_uploaded():
    """清单缺失/损坏/非 dict 时视为空清单。"""
    try:
        with open(UPLOADED, encoding="utf-8") as f:
            u = json.load(f)
        if isinstance(u, dict):
            return u
    except FileNotFoundError:
        pass
    except Exception as e:
        print("[warn] uploaded manifest corrupt, treat as empty:", e)
    return {}


def save_uploaded(u):
    tmp = UPLOADED + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(u, f, ensure_ascii=False, sort_keys=True)
        f.write("\n")
    os.replace(tmp, UPLOADED)


def main():
    if not SID or not SKEY:
        print("COS_SECRET_ID / COS_SECRET_KEY not set, skip COS upload"); return 0
    ids = []
    if os.path.exists(CHANGED):
        with open(CHANGED, encoding="utf-8") as f:
            ids = [x.strip() for x in f if x.strip()]
    if not ids:
        print("nothing to upload"); return 0

    uploaded = load_uploaded()
    items = []  # (ts, id, sha, body)
    for cid in dict.fromkeys(ids):
        p = os.path.join(ART_DIR, f"{cid}.json")
        if not os.path.exists(p):
            continue
        with open(p, "rb") as f:
            b = f.read()
        sha = hashlib.sha1(b).hexdigest()[:16]
        if uploaded.get(cid) == sha:
            continue
        try:
            ts = json.loads(b.decode("utf-8")).get("ts")
            ts = ts if isinstance(ts, (int, float)) and not isinstance(ts, bool) else 0
        except Exception:
            ts = 0
        items.append((ts, cid, sha, b))
    items.sort(key=lambda x: x[0], reverse=True)  # 最近优先

    start = time.time()
    ok = fail = 0
    since_save = 0
    done = 0
    try:
        for ts, cid, sha, b in items:
            if time.time() - start >= BUDGET:
                break
            st, info = put(f"data/articles/{cid}.json", b)
            done += 1
            if st == 200:
                uploaded[cid] = sha; ok += 1; since_save += 1
                if since_save >= SAVE_EVERY:
                    save_uploaded(uploaded); since_save = 0
            else:
                fail += 1
                if fail < 5: print("put fail", cid, st, info[:150])
    finally:
        save_uploaded(uploaded)
    remaining = len(items) - done
    if remaining:
        print(f"budget reached, remaining {remaining}")
    print(f"COS incremental upload: total={len(items)} ok={ok} fail={fail} remaining={remaining}")
    if fail > 5 and fail > ok * FAIL_RATIO:
        print("too many COS upload failures"); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
