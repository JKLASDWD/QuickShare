#!/usr/bin/env python3
"""Render the bundled Nginx template to stdout; does not install certificates."""
import argparse
import re
from pathlib import Path


def domain_name(value):
    value = value.lower()
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if len(value) > 253 or not re.fullmatch(label + r"(?:\." + label + r")+", value):
        raise argparse.ArgumentTypeError("请输入纯域名，不含协议、路径或端口；国际化域名使用 punycode")
    return value


def certificate_path(value):
    if not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value):
        raise argparse.ArgumentTypeError("证书路径必须是绝对路径，仅含字母、数字、下划线、点、斜杠或连字符")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, type=domain_name)
    parser.add_argument("--cert", type=certificate_path)
    parser.add_argument("--key", type=certificate_path)
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error("--cert 和 --key 必须同时提供")
    cert = args.cert or f"/etc/letsencrypt/live/{args.domain}/fullchain.pem"
    key = args.key or f"/etc/letsencrypt/live/{args.domain}/privkey.pem"
    template = Path(__file__).with_name("quickshare.conf.example").read_text(encoding="utf-8")
    result = template.replace("server_name share.example.com;", f"server_name {args.domain};")
    result = result.replace("/etc/letsencrypt/live/share.example.com/fullchain.pem", cert)
    result = result.replace("/etc/letsencrypt/live/share.example.com/privkey.pem", key)
    print(result, end="")


if __name__ == "__main__":
    main()
