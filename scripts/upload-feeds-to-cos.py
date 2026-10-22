#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 4 个 feed JSON 逐个签名 PUT 到腾讯 COS（替代会在 Actions 上卡住的 coscmd）。

  - 每个文件独立上传；单次 PUT 超时 120s；失败最多重试 3 次（指数退避 2s/4s/8s）
  - 一个文件失败不影响其它文件；有失败退出 1，全部成功（或跳过）退出 0
  - 文件不存在 -> 警告并跳过（不算失败）
  - 纯标准库；签名/Content-Type 与 upload-articles-to-cos.py 保持一致；密钥不打印

环境变量：
  COS_SECRET_ID / COS_SECRET_KEY   缺失则跳过（退出 0）
  COS_BUCKET / COS_REGION          默认 vw-data-1311399697 / ap-guangzhou
  COS_ENDPOINT                     覆盖 https://{bucket}.cos.{region}.myqcloud.com（测试用）
  FEED_PUT_TIMEOUT / FEED_BACKOFF_BASE   单次超时秒数(默认120) / 退避基数秒(默认2)（测试用）
"""
import hashlib
import hmac
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 只传视频号：official/look/ai-review 由 update-official.yml 负责上传（那边传的是剥离正文后的小文件），
# 这里不再重复传大文件，避免跨洋传大文件卡住，也避免两条流水线互相覆盖。
FILES = ["channels-feed.json"]

SID = os.environ.get("COS_SECRET_ID", "")
SKEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "vw-data-1311399697")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
ENDPOINT = (os.environ.get("COS_ENDPOINT") or f"https://{BUCKET}.cos.{REGION}.myqcloud.com").rstrip("/")
HOST = urllib.parse.urlparse(ENDPOINT).netloc
TIMEOUT = float(os.environ.get("FEED_PUT_TIMEOUT") or 120)
BACKOFF = float(os.environ.get("FEED_BACKOFF_BASE") or 2)
RETRIES = 3


def h(k, m):
    return hmac.new(k, m.encode("utf-8"), hashlib.sha256).digest()


def put_once(key, body, ct="application/json; charset=utf-8"):
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
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        return opener.open(req, timeout=TIMEOUT).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # 超时/连接错误；只打印异常类型，避免泄露任何头信息
        print(f"  {key}: {type(e).__name__}")
        return -1


def upload(key, body):
    """返回 (状态码, 重试次数)；200 视为成功。"""
    st = -1
    for attempt in range(RETRIES + 1):
        st = put_once(key, body)
        if st == 200:
            return st, attempt
        if attempt < RETRIES:
            time.sleep(BACKOFF * (2 ** attempt))
    return st, RETRIES


def main():
    if not SID or not SKEY:
        print("COS secrets not set, skip"); return 0
    results = []
    for name in FILES:
        path = os.path.join(BASE, "data", name)
        if not os.path.exists(path):
            print(f"[warn] {path} not found, skip"); results.append((name, 0, "skip", 0)); continue
        try:
            with open(path, "rb") as f:
                body = f.read()
            st, retries = upload(f"data/{name}", body)
        except Exception as e:
            print(f"  {name}: {type(e).__name__}")
            results.append((name, 0, -1, 0)); continue
        results.append((name, len(body), st, retries))
    failed = 0
    for name, size, st, retries in results:
        ok = st == 200 or st == "skip"
        failed += 0 if ok else 1
        print(f"{'OK  ' if ok else 'FAIL'} {name} bytes={size} status={st} retries={retries}")
    print(f"[COS] feeds done: failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
