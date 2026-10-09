#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
腾讯云 COS 图片上传工具（纯标准库实现，无需安装 SDK）。

用法：
    python3 cos_upload.py [--cache-bust] <本地文件路径|图片URL> [远程相对路径]
    python3 cos_upload.py ./shot.png
    python3 cos_upload.py ./shot.png guide/step1.png
    python3 cos_upload.py --cache-bust ./shot.png guide/step1.png
    python3 cos_upload.py https://example.com/pic.png product/arch.png

配置：
    复制 cos_config.example.json 为 cos_config.json，或设置环境变量
    COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
    （可选）COS_KEY_PREFIX / COS_PUBLIC_BASE
    优先级：环境变量 > cos_config.json

说明：
    - 成功时 stdout 仅输出公网 URL；日志走 stderr。
    - --cache-bust：在 URL 后追加 ?v=YYYYMMDDHHMMSS，便于覆盖同 key 后绕过 CDN 缓存。
"""
import argparse
import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import sys
import time
import urllib.parse
from datetime import datetime

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _config_candidates():
    """配置查找顺序：COS_CONFIG → 脚本旁 → 向上查找 knowledge 根下的 cos_config.json。"""
    out = []
    env_path = os.environ.get("COS_CONFIG")
    if env_path:
        out.append(os.path.expanduser(env_path))
    out.append(os.path.join(_SCRIPT_DIR, "cos_config.json"))
    # 从 cwd / 脚本目录向上找仓库根配置（便于团队共用，勿提交该文件）
    for start in (os.getcwd(), _SCRIPT_DIR):
        cur = os.path.abspath(start)
        for _ in range(8):
            out.append(os.path.join(cur, "cos_config.json"))
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
    # 去重保序
    seen = set()
    uniq = []
    for p in out:
        ap = os.path.abspath(p)
        if ap not in seen:
            seen.add(ap)
            uniq.append(ap)
    return uniq


def _load_config():
    """加载配置：环境变量优先，其次 cos_config.json。缺少必填项时清晰报错。"""
    file_cfg = {}
    loaded_from = None
    for path in _config_candidates():
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                file_cfg = json.load(f)
            loaded_from = path
            break
        except (json.JSONDecodeError, OSError) as e:
            raise SystemExit(f"[ERROR] 读取 cos_config.json 失败 ({path}): {e}")

    def pick(env_key, cfg_key, default=None):
        val = os.environ.get(env_key)
        if val is None or val == "":
            val = file_cfg.get(cfg_key, default)
        return val

    cfg = {
        "secret_id": pick("COS_SECRET_ID", "secret_id"),
        "secret_key": pick("COS_SECRET_KEY", "secret_key"),
        "bucket": pick("COS_BUCKET", "bucket"),
        "region": pick("COS_REGION", "region"),
        "key_prefix": pick("COS_KEY_PREFIX", "key_prefix", "") or "",
        "public_base": pick("COS_PUBLIC_BASE", "public_base", "") or "",
    }

    missing = [name for name in ("secret_id", "secret_key", "bucket", "region")
               if not cfg[name]]
    if missing:
        raise SystemExit(
            "[ERROR] 缺少 COS 配置项: " + ", ".join(missing) + "\n"
            "        请复制 skills 内 cos_config.example.json 为 cos_config.json 并填写，\n"
            "        或设置环境变量 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION，\n"
            "        或设置 COS_CONFIG 指向配置文件路径。"
            + (f"\n        （已尝试读取: {loaded_from}）" if loaded_from else "")
        )

    cfg["host"] = f"{cfg['bucket']}.cos.{cfg['region']}.myqcloud.com"
    if not cfg["public_base"]:
        cfg["public_base"] = f"https://{cfg['host']}/"
    if not cfg["public_base"].endswith("/"):
        cfg["public_base"] += "/"
    prefix = cfg["key_prefix"].lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    cfg["key_prefix"] = prefix
    return cfg


def _hmac_sha1(key, msg):
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha1).hexdigest()


def _build_auth(cfg, method, uri_path, headers, params=None):
    """腾讯云 COS 请求签名 v5。"""
    params = params or {}
    now = int(time.time())
    key_time = f"{now - 300};{now + 3600}"
    sign_key = _hmac_sha1(cfg["secret_key"], key_time)

    fmt_params = {k.lower(): urllib.parse.quote(str(v), safe="") for k, v in params.items()}
    param_list = ";".join(sorted(fmt_params.keys()))
    http_params = "&".join(f"{k}={fmt_params[k]}" for k in sorted(fmt_params.keys()))

    fmt_headers = {k.lower(): urllib.parse.quote(str(v), safe="") for k, v in headers.items()}
    header_list = ";".join(sorted(fmt_headers.keys()))
    http_headers = "&".join(f"{k}={fmt_headers[k]}" for k in sorted(fmt_headers.keys()))

    http_string = f"{method.lower()}\n{uri_path}\n{http_params}\n{http_headers}\n"
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode('utf-8')).hexdigest()}\n"
    signature = _hmac_sha1(sign_key, string_to_sign)

    return (
        f"q-sign-algorithm=sha1&q-ak={cfg['secret_id']}"
        f"&q-sign-time={key_time}&q-key-time={key_time}"
        f"&q-header-list={header_list}&q-url-param-list={param_list}"
        f"&q-signature={signature}"
    )


def _load_source(source):
    """本地路径或 http(s) URL → (body_bytes, filename)。"""
    if source.startswith("http://") or source.startswith("https://"):
        import urllib.request
        req = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            content_type = r.headers.get_content_type() if hasattr(r.headers, "get_content_type") else None
        path = urllib.parse.urlparse(source).path
        filename = os.path.basename(path) or "image"
        if "." not in filename:
            ext = mimetypes.guess_extension(content_type or "") or ".png"
            filename += ext
        return body, filename

    path = os.path.expanduser(source)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"文件不存在: {path}")
    with open(path, "rb") as f:
        return f.read(), os.path.basename(path)


def upload(source, remote_rel=None, cfg=None, cache_bust=False):
    cfg = cfg or _load_config()
    host = cfg["host"]
    key_prefix = cfg["key_prefix"]

    body, filename = _load_source(source)
    if remote_rel:
        key = key_prefix + remote_rel.lstrip("/")
    else:
        md5_short = hashlib.md5(body).hexdigest()[:8]
        ym = datetime.now().strftime("%Y%m")
        key = f"{key_prefix}{ym}/{md5_short}-{filename}"

    sign_path = "/" + key
    request_path = "/" + urllib.parse.quote(key, safe="/")
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    headers_to_sign = {"host": host}

    last_err = None
    for attempt in range(1, 4):
        auth = _build_auth(cfg, "PUT", sign_path, headers_to_sign)
        conn = http.client.HTTPSConnection(host, timeout=30)
        req_headers = {
            "Host": host,
            "Authorization": auth,
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache, max-age=0",
        }
        try:
            conn.request("PUT", request_path, body=body, headers=req_headers)
            resp = conn.getresponse()
            resp_body = resp.read().decode("utf-8", "ignore")
            status = resp.status
        finally:
            conn.close()

        if status in (200, 204):
            public_url = cfg["public_base"] + urllib.parse.quote(key, safe="/")
            if cache_bust:
                public_url += "?v=" + datetime.now().strftime("%Y%m%d%H%M%S")
            sys.stderr.write(f"[OK] 已上传 -> COS key: {key}\n")
            return public_url

        last_err = f"HTTP {status}: {resp_body}"
        sys.stderr.write(f"[WARN] 第 {attempt} 次上传失败，重试中… {last_err}\n")
        time.sleep(1)

    raise RuntimeError(f"上传失败（已重试 3 次）: {last_err}")


def main():
    parser = argparse.ArgumentParser(
        description="上传本地/远程图片到腾讯云 COS，stdout 输出公网 URL。"
    )
    parser.add_argument(
        "--cache-bust",
        action="store_true",
        help="在返回 URL 后追加 ?v=时间戳，便于同 key 覆盖后绕过缓存",
    )
    parser.add_argument("source", help="本地文件路径或 http(s) 图片 URL")
    parser.add_argument(
        "remote_rel",
        nargs="?",
        default=None,
        help="相对 key_prefix 的远程路径；省略则自动生成",
    )
    args = parser.parse_args()

    try:
        cfg = _load_config()
        url = upload(args.source, args.remote_rel, cfg=cfg, cache_bust=args.cache_bust)
        print(url)
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write(f"[ERROR] {e}\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
