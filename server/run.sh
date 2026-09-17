#!/usr/bin/env bash
# 启动 Web 网关(前端 + REST API + 转发队友 C++ faceauth)
# 用法: bash run.sh   或在 server/ 目录直接 python3 app.py
set -e
cd "$(dirname "$0")"

if [ ! -f config.json ]; then
  echo "==> 首次运行:由 config.example.json 生成 config.json,请按需修改路径/数据库密码"
  cp config.example.json config.json
fi

# 提示缺依赖
if ! python3 -c "import pymysql" 2>/dev/null; then
  echo "==> 缺少 pymysql,尝试安装: pip3 install -r requirements.txt 或 sudo apt install python3-pymysql"
  exit 1
fi

exec python3 app.py "$@"
