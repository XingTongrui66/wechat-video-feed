#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐个签名 PUT feed JSON 到腾讯 COS。"""
import hashlib
import hmac
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED_FILES = {
    "channels-feed.json",
    "official-feed.json",
    "look-feed.json",
    "ai-review.json",
}

SID = os.environ.get("COS_SECRET_ID", "")
SKEY = os.environ.get("COS_SECRET_KEY", "")
BUCKET = os.environ.get("COS_BUCKET", "vw-data-1311399697")
REGION = os.environ.get("COS_REGION", "ap-guangzhou")
ENDPOINT = (os.environ.get("COS_ENDPOINT") or f"https://{BUCKET}.cos.{REGION}.myqcloud.com").rstrip("/")
HOST = urllib.parse.urlparse(ENDPOINT).netloc
TIMEOUT = float(os.environ.get("FEED_PUT_TIMEOUT") or 120)
BACKOFF = float(os.environ.get("FEED_BACKOFF_BASE") or 2)
RETRIES = 3


def feed_files():
    value = os.environ.get("COS_FEED_FILES")
    names = ["channels-feed.json"] if value is None else [name.strip() for name in value.split(",")]
    if not names or any(name not in ALLOWED_FILES for name in names):
        raise ValueError("COS_FEED_FILES must contain only supported feed filenames")
    return names


def h(key, message):
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def put_once(key, body, ct="application/json; charset=utf-8"):
    t0 = int(time.time())
    kt = f"{t0};{t0 + 3000}"
    dp = time.strftime("%Y-%m-%d", time.gmtime(t0))
    md5 = hashlib.md5(body).hexdigest()
    canon = "PUT/" + key + "/\n" + f"content-type:{ct};host:{HOST};\ncontent-type;host\n{md5}"
    sts = "TC3-HMAC-SHA256\n" + kt + "\n/cos/" + dp + "/qcs\n" + hashlib.sha256(canon.encode()).hexdigest()
    key_date = h(SKEY.encode(), dp)
    key_service = h(key_date, "cos")
    key_region = h(key_service, REGION)
    key_signing = h(key_region, "qcs")
    sig = hmac.new(key_signing, sts.encode(), hashlib.sha256).hexdigest()
    auth = f"TC3-HMAC-SHA256 Credential={SID}/{kt}/cos/{dp}/qcs, SignedHeaders=content-type;host, Signature={sig}"
    req = urllib.request.Request(f"{ENDPOINT}/{key}", data=body, method="PUT")
    req.add_header("Content-Type", ct)
    req.add_header("Host", HOST)
    req.add_header("X-TC-Action", "PutObject")
    req.add_header("X-TC-Timestamp", str(t0))
    req.add_header("Authorization", auth)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        return opener.open(req, timeout=TIMEOUT).status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception as error:
        print(f"  {key}: {type(error).__name__}")
        return -1


def upload(key, body):
    status = -1
    for attempt in range(RETRIES):
        status = put_once(key, body)
        if status == 200:
            return status, attempt
        if attempt < RETRIES - 1:
            time.sleep(BACKOFF * (2 ** attempt))
    return status, RETRIES - 1


def main():
    try:
        names = feed_files()
    except ValueError as error:
        print(error)
        return 1
    if not SID or not SKEY:
        print("COS secrets not set, skip")
        return 0

    results = []
    for name in names:
        path = os.path.join(BASE, "data", name)
        if not os.path.isfile(path):
            print(f"[error] {path} not found")
            results.append((name, 0, -1, 0))
            continue
        try:
            with open(path, "rb") as file:
                body = file.read()
            status, retries = upload(f"data/{name}", body)
        except Exception as error:
            print(f"  {name}: {type(error).__name__}")
            results.append((name, 0, -1, 0))
            continue
        results.append((name, len(body), status, retries))

    failed = 0
    for name, size, status, retries in results:
        ok = status == 200
        failed += not ok
        print(f"{'OK  ' if ok else 'FAIL'} {name} bytes={size} status={status} retries={retries}")
    print(f"[COS] feeds done: failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
