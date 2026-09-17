#!/usr/bin/env bash
# ============================================================================
# 一键启动 人脸认证 Web 网关(含常驻 faceauth_worker)
#
# 用法:  bash start.sh
# 作用:  停止旧的网关/worker -> 检查 pymysql -> 启动网关(worker 由网关自动拉起)
#        日志写入 /tmp/gateway.log
# HTTPS: 若 server/certs/cert.pem + key.pem 存在,网关自动以 HTTPS 启动。
#        生成证书: bash gen_cert.sh [局域网IP]
# 访问:  本机 https://127.0.0.1:8000 (证书存在) 或 http://127.0.0.1:8000
#        Windows: ssh -N -L 8000:127.0.0.1:8000 zero@<Ubuntu-IP>
#        然后浏览器开 https://localhost:8000 (自签证书需点“高级→继续”)
# ============================================================================
set -e
cd "$(dirname "$0")"
LOG=/tmp/gateway.log

SCHEME=http
if [ -f certs/cert.pem ] && [ -f certs/key.pem ]; then
  SCHEME=https
fi

echo "==> 停止旧网关 / worker"
pkill -9 -f "python3.*app\.py" 2>/dev/null || true   # 覆盖 python3 app.py 与 python3 -u app.py
pkill -9 -f "faceauth_worker" 2>/dev/null || true
sleep 1

echo "==> 检查 python 依赖"
python3 -c "import pymysql" 2>/dev/null || { echo "缺少 pymysql,请先: pip3 install pymysql 或 sudo apt install -y python3-pymysql"; exit 1; }

echo "==> 检查常驻 worker 是否已编译"
if [ -f worker/build/faceauth_worker ]; then
  echo "    worker 就绪: worker/build/faceauth_worker"
else
  echo "    警告: 未找到 worker/build/faceauth_worker,将退化为 CLI 模式(慢)。"
  echo "    编译: cd worker && cmake -S . -B build -DONNXRUNTIME_ROOT=/opt/onnxruntime && cmake --build build -j\$(nproc)"
fi

echo "==> 启动网关(日志: $LOG)  [协议: $SCHEME]"
nohup python3 -u app.py > "$LOG" 2>&1 &
echo "==> 等待端口就绪..."
for _ in $(seq 1 20); do
  if ss -ltn 2>/dev/null | grep -q ':8000'; then break; fi
  sleep 1
done

echo "------------------------------------------------------------"
tail -n 14 "$LOG"
echo "------------------------------------------------------------"
if ss -ltn 2>/dev/null | grep -q ':8000'; then
  echo "已启动: 本机 $SCHEME://127.0.0.1:8000"
  if [ "$SCHEME" = "https" ]; then
    echo "HTTPS 自签证书:浏览器首次会警告,点 高级→继续访问 localhost 即可"
  fi
  echo "Windows 访问: ssh -N -L 8000:127.0.0.1:8000 zero@<Ubuntu-IP> 然后开 $SCHEME://localhost:8000"
else
  echo "启动失败,请查看上面日志(或: cat $LOG)"
  exit 1
fi
