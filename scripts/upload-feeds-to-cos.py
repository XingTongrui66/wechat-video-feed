#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐个签名 PUT feed JSON 到腾讯 COS。

环境变量：
  COS_FEED_FILES     逗号分隔的待传文件（须在白名单内），未设置时只传 channels-feed.json
  COS_FEED_OPTIONAL  逗号分隔的可选文件（须是 COS_FEED_FILES 的子集），失败只告警、不让退出码非零；默认为空
  COS_FEED_SRC       逗号分隔的 <文件名>=<本地路径>，用该路径内容上传到 data/<文件名>（文件名须在 COS_FEED_FILES 内）；默认为空
  COS_ENDPOINT       覆盖 COS 地址（默认 https://{bucket}.cos.{region}.myqcloud.com）
  FEED_PUT_TIMEOUT   单次 PUT 超时秒数（默认 120）
  FEED_BACKOFF_BASE  重试退避基数秒数（默认 2）
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


def optional_files(names):
    value = os.environ.get("COS_FEED_OPTIONAL") or ""
    optional = {name.strip() for name in value.split(",") if name.strip()}
    if any(name not in ALLOWED_FILES or name not in names for name in optional):
        raise ValueError("COS_FEED_OPTIONAL must be a subset of COS_FEED_FILES")
    return optional


def source_overrides(names):
    # COS_FEED_SRC="ai-review.json=/tmp/x.json"：用本地文件替代 data/<name> 作为上传内容，对象键不变
    value = os.environ.get("COS_FEED_SRC") or ""
    overrides = {}
    for item in value.split(","):
        if not item.strip():
            continue
        name, sep, path = item.partition("=")
        name, path = name.strip(), path.strip()
        if not sep or not path or name not in ALLOWED_FILES or name not in names:
            raise ValueError("COS_FEED_SRC entries must be <name>=<path> with name in COS_FEED_FILES")
        overrides[name] = path
    return overrides


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
        optional = optional_files(names)
        overrides = source_overrides(names)
    except ValueError as error:
        print(error)
        return 1
    if not SID or not SKEY:
        print("COS secrets not set, skip")
        return 0

    results = []
    for name in names:
        path = overrides.get(name) or os.path.join(BASE, "data", name)
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
    optional_failed = 0
    for name, size, status, retries in results:
        ok = status == 200
        if not ok and name in optional:
            optional_failed += 1
            print(f"WARN {name} bytes={size} status={status} retries={retries}")
            print(f"::warning::data/{name} 本轮未上传到 COS（status={status}），下轮重试；不影响正文和列表上传")
            continue
        failed += not ok
        print(f"{'OK  ' if ok else 'FAIL'} {name} bytes={size} status={status} retries={retries}")
    print(f"[COS] feeds done: failed={failed} optional_failed={optional_failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
