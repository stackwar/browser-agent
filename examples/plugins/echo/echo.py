#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""示例插件工具:从 stdin 读入参 JSON,回显其中的 text 字段到 stdout。

插件约定:stdout 作为工具结果回给模型,非 0 退出码按失败处理(stderr 作错误说明)。
"""
import json
import sys


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    text = data.get("text", "")
    # stdout 即工具返回给模型的内容
    print(f"echo: {text}")


if __name__ == "__main__":
    main()
