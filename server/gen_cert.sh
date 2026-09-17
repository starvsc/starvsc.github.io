#!/usr/bin/env bash
# 生成网关 HTTPS 自签证书(server/certs)
# 用法: bash gen_cert.sh [局域网IP]
#   例: bash gen_cert.sh 192.168.161.128   (可选,便于直接用 IP 访问)
# 生成后重启网关(bash start.sh)即启用 HTTPS。
set -e
cd "$(dirname "$0")"
mkdir -p certs
IP="${1:-}"
SAN="DNS:localhost,IP:127.0.0.1"
[ -n "$IP" ] && SAN="$SAN,IP:$IP"

openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=localhost/O=FaceAuthDev" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=CA:FALSE"

chmod 600 certs/key.pem
echo "证书已生成: $(pwd)/certs/cert.pem (SAN: $SAN)"
echo "重启网关生效: bash start.sh"
