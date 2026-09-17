#!/usr/bin/env bash
# 生成 根CA + localhost 服务器证书,彻底消除 HTTPS 自签警告
#
# 产物(server/certs/):
#   ca.pem    根证书 —— 需导入 Windows「受信任的根证书颁发机构」
#   cert.pem  服务器证书(localhost/127.0.0.1/局域网IP),网关使用
#   key.pem   服务器私钥
#
# 用法: bash gen_ca_certs.sh [局域网IP]   例: bash gen_ca_certs.sh 192.168.161.128
# 之后: 重启网关 bash start.sh;把 ca.pem 导入 Windows 受信任根(见文档)。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
IP="${1:-192.168.161.128}"
RND="$(mktemp -d)"
trap 'rm -rf "$RND"' EXIT

echo "==> 1/3 生成根 CA (ca.pem)"
openssl genrsa -out certs/ca.key 3072 2>/dev/null
openssl req -x509 -new -key certs/ca.key -sha256 -days 3650 -out certs/ca.pem \
  -subj "/CN=FaceAuthDev-RootCA/O=FaceAuthDev" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo "==> 2/3 生成服务器私钥 + CSR"
openssl genrsa -out certs/key.pem 2048 2>/dev/null
openssl req -new -key certs/key.pem -out "$RND/server.csr" \
  -subj "/CN=localhost/O=FaceAuthDev"

echo "==> 3/3 用根 CA 签发服务器证书 (SAN: localhost, 127.0.0.1, $IP)"
cat > "$RND/ext.cnf" <<EOF
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$IP
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$RND/server.csr" -CA certs/ca.pem -CAkey certs/ca.key \
  -CAcreateserial -days 825 -sha256 -out certs/cert.pem \
  -extfile "$RND/ext.cnf"

chmod 600 certs/ca.key certs/key.pem
echo
echo "完成。下一步:"
echo "  1) 重启网关: bash start.sh"
echo "  2) Windows 导入根证书(管理员命令行):"
echo "     certutil -addstore -f Root \"<共享或本地路径>\\server\\certs\\ca.pem\""
echo "  3) 完全关闭并重开浏览器,访问 https://localhost:8000 不再警告"
