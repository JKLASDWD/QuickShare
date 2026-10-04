#!/usr/bin/env bash
# QuickShare installer: run from a downloaded/cloned source tree.
# Step-by-step UX inspired by Coolify; implementation is specific to QuickShare.
set -Eeuo pipefail
umask 077
DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$DEPLOY_DIR"
configure_only=false
case "${1:-}" in
  --configure-only) configure_only=true ;;
  --help|-h) printf '用法: bash deploy/install.sh [--configure-only]\n需 Linux、Bash、OpenSSL、curl；Docker 不存在时可选择安装。\n'; exit 0 ;;
  '') ;;
  *) printf '未知选项: %s\n' "$1" >&2; exit 1 ;;
esac
die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
trap 'printf "\n部署失败（步骤命令所在行 %s）。配置已保留；按原命令重试。\n" "$LINENO" >&2' ERR
ask() { local prompt=$1 default=$2 value; printf '%s [%s]: ' "$prompt" "$default" >&2; read -r value || die '需要交互输入'; printf '%s' "${value:-$default}"; }
yes() { local answer; printf '%s [y/N]: ' "$1" >&2; read -r answer || return 1; [[ "$answer" == y || "$answer" == Y ]]; }
env_value() { local value; value=$(sed -n "s/^${1}=//p" .env 2>/dev/null | tail -n 1); value=${value%$'\r'}; value=${value#\"};value=${value%\"};value=${value#\'};value=${value%\'};printf '%s' "$value"; }
ipv4() { local ip=$1 part; [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1; local -a parts; IFS=. read -ra parts <<< "$ip";for part in "${parts[@]}";do ((${#part}<=3&&10#$part<=255)) || return 1;done; }
domain_ok() { [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$1" == *.* && "$1" != *..* && ${#1} -le 253 ]]; }
[[ $(uname -s) == Linux ]] || die '服务端需要 Linux；Windows 请在 Linux 服务器上运行。'
for tool in openssl curl sed awk;do command -v "$tool" >/dev/null || die "缺少 $tool，请先安装。";done
step 1 '选择部署方式'
printf '1) 域名 HTTPS（Caddy 自动证书）\n2) IP 自签名 HTTPS（无域名）\n3) 内网 HTTP（仅可信内网/VPN）\n4) 已有宿主机 Nginx（需现成证书）\n'
mode=$(ask '选择' '1')
case "$mode" in
  1) compose_file=docker-compose.yml ;;
  2) compose_file=docker-compose.selfsigned.yml ;;
  3) compose_file=docker-compose.ip.yml ;;
  4) compose_file=docker-compose.nginx.yml ;;
  *) die '请选择 1–4' ;;
esac
project_default=quickshare
if [[ -f .quickshare-deploy ]];then
  saved_mode=$(sed -n 's/^MODE=//p' .quickshare-deploy)
  [[ "$saved_mode" == "$mode" ]] || die '已部署其他模式。请使用原模式；切换入口前先按部署文档处理旧服务。'
  project_default=$(sed -n 's/^PROJECT=//p' .quickshare-deploy)
fi
project=$(ask 'Compose 项目名（已有部署必须沿用原名）' "$project_default")
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die '项目名仅支持小写字母、数字、下划线和连字符'
if [[ -f .quickshare-deploy && "$project" != "$project_default" ]];then die '项目名与已保存部署不一致';fi
step 2 '准备配置（现有配置优先复用）'
domain='' ip='' tls_port=8989
if [[ -f .env ]];then
  printf '找到 .env，将保留现有地址、密钥和令牌。\n'
  domain=$(env_value SHARE_DOMAIN);ip=$(env_value SERVER_IP);tls_port=$(env_value TLS_PORT);tls_port=${tls_port:-8989}
  secret=$(env_value LIVEKIT_API_SECRET);auth=$(env_value AUTH_TOKEN);livekit_config=$(env_value LIVEKIT_CONFIG);livekit_config=${livekit_config:-./livekit.yaml}
  [[ -n "$secret" && -n "$auth" ]] || die '.env 中 LIVEKIT_API_SECRET/AUTH_TOKEN 不能为空；请补齐后重试。'
else
  if [[ "$mode" == 1 || "$mode" == 4 ]];then domain=$(ask '域名（不带 https://）' 'share.example.com');domain_ok "$domain" || die '域名格式无效';[[ "$domain" != share.example.com ]] || die '请填写真实域名';fi
  if [[ "$mode" == 2 || "$mode" == 3 ]];then ip=$(ask '服务器 IPv4' '');ipv4 "$ip" || die '请填写正确的 IPv4';fi
  if [[ "$mode" == 2 ]];then tls_port=$(ask 'HTTPS 端口' '8989');fi
  secret=$(openssl rand -hex 32);auth=$(openssl rand -hex 32);livekit_config=./livekit.local.yaml
  [[ ! -e "$livekit_config" ]] || die '已有 livekit.local.yaml，但没有 .env；请恢复匹配的 .env，避免覆盖密钥。'
  sed "s/^  devkey: .*/  devkey: $secret/" livekit.yaml > "$livekit_config"
  printf 'LIVEKIT_CONFIG=%s\nSHARE_DOMAIN=%s\nSERVER_IP=%s\nTLS_PORT=%s\nLIVEKIT_API_SECRET=%s\nAUTH_TOKEN=%s\n' "$livekit_config" "$domain" "$ip" "$tls_port" "$secret" "$auth" > .env
fi
case "$mode" in
  1|4) domain_ok "$domain" || die '.env 中 SHARE_DOMAIN 无效';url="https://$domain" ;;
  2|3) ipv4 "$ip" || die '.env 中 SERVER_IP 无效';[[ "$tls_port" =~ ^[0-9]{1,5}$ ]] && ((10#$tls_port>=1&&10#$tls_port<=65535)) || die 'TLS_PORT 必须为 1–65535';url="https://$ip:$tls_port";[[ "$mode" != 3 ]] || url="http://$ip:8080" ;;
esac
[[ -f "$livekit_config" ]] || die "找不到 LiveKit 配置：$livekit_config"
yaml_secret=$(awk '$1=="devkey:" {print $2;exit}' "$livekit_config");yaml_secret=${yaml_secret#\"};yaml_secret=${yaml_secret%\"};yaml_secret=${yaml_secret#\'};yaml_secret=${yaml_secret%\'}
[[ "$yaml_secret" == "$secret" ]] || die 'LiveKit keys.devkey 与 .env 中 LIVEKIT_API_SECRET 不一致'
chmod 600 .env "$livekit_config"
# Keep Compose interpolation aligned with the validated files, even if the caller
# exported credentials or addresses from a different deployment.
export LIVEKIT_API_SECRET="$secret" AUTH_TOKEN="$auth" LIVEKIT_CONFIG="$livekit_config" SHARE_DOMAIN="$domain" SERVER_IP="$ip" TLS_PORT="$tls_port"
step 3 '准备 HTTPS 入口'
nginx_target=''
if [[ "$mode" == 2 ]];then
  mkdir -p caddy/certs
  if [[ -e caddy/certs/server.crt || -e caddy/certs/server.key ]];then
    [[ -f caddy/certs/server.crt && -f caddy/certs/server.key ]] || die '证书与私钥必须同时存在'
    openssl x509 -in caddy/certs/server.crt -noout -checkip "$ip" >/dev/null || die '已有证书不匹配当前 IP，需手动更新'
    openssl x509 -in caddy/certs/server.crt -noout -checkend 0 >/dev/null || die '已有证书已过期，需手动更新'
  else
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 -subj '/CN=QuickShare Server' -addext "subjectAltName=IP:$ip" -addext 'basicConstraints=critical,CA:FALSE' -addext 'keyUsage=critical,digitalSignature,keyEncipherment' -addext 'extendedKeyUsage=serverAuth' -keyout caddy/certs/server.key -out caddy/certs/server.crt 2>/dev/null
  fi
  chmod 600 caddy/certs/server.key;chmod 644 caddy/certs/server.crt
elif [[ "$mode" == 4 ]];then
  cert=$(ask '现有证书路径' "/etc/letsencrypt/live/$domain/fullchain.pem")
  key=$(ask '现有证书私钥路径' "/etc/letsencrypt/live/$domain/privkey.pem")
  [[ "$cert" =~ ^/[a-zA-Z0-9_./-]+$ && "$key" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die '请使用不含空格的绝对证书路径'
  if ! $configure_only;then [[ -f "$cert" && -f "$key" ]] || die '证书或私钥不存在，请先申请证书';fi
  generated=nginx/quickshare.generated.conf
  if [[ ! -e "$generated" ]];then
    sed -e "s|/etc/letsencrypt/live/share.example.com/fullchain.pem|$cert|g" -e "s|/etc/letsencrypt/live/share.example.com/privkey.pem|$key|g" -e "s/share.example.com/$domain/g" nginx/quickshare.conf.example > "$generated"
  else
    grep -Fq "server_name $domain;" "$generated" && grep -Fq "ssl_certificate $cert;" "$generated" && grep -Fq "ssl_certificate_key $key;" "$generated" || die '已有 nginx/quickshare.generated.conf 与本次输入不匹配，请先检查该文件'
  fi
  nginx_target=$(ask 'Nginx 站点安装路径（须由 http 加载）' '/etc/nginx/conf.d/quickshare.conf')
  [[ "$nginx_target" =~ ^/[a-zA-Z0-9_./-]+\.conf$ ]] || die 'Nginx 站点路径须为不含空格的绝对 .conf 路径'
fi
if $configure_only;then printf '\n配置已准备。未安装依赖、未启动服务、未修改系统 Nginx。\n入口：%s\n配置：%s/.env\n' "$url" "$DEPLOY_DIR";exit 0;fi
step 4 '检查 Docker 与 Compose'
sudo_cmd=()
if ((EUID!=0));then command -v sudo >/dev/null || die '需要 root 或 sudo';sudo_cmd=(sudo);fi
if ! command -v docker >/dev/null;then
  yes '未找到 Docker，是否使用 Docker 官方安装脚本安装？' || die '请安装 Docker Engine 和 Compose 后重试'
  installer="$DEPLOY_DIR/docker-install-$(date +%s).sh"
  curl -fsSL https://get.docker.com -o "$installer"
  "${sudo_cmd[@]}" sh "$installer"
fi
docker_cmd=("${sudo_cmd[@]}" docker)
"${docker_cmd[@]}" info >/dev/null 2>&1 || die 'Docker 未运行或当前用户没有访问权限'
"${docker_cmd[@]}" compose version >/dev/null 2>&1 || die '缺少 Docker Compose 插件'
compose=("${docker_cmd[@]}" compose --env-file "$DEPLOY_DIR/.env" -p "$project" -f "$compose_file")
"${compose[@]}" config --quiet
if [[ "$mode" == 4 ]];then
  command -v nginx >/dev/null || die '未找到宿主机 Nginx'
fi
step 5 '确认并启动'
printf '模式：%s\n项目：%s\n客户端地址：%s\n' "$compose_file" "$project" "$url"
printf '请先放行媒体 TCP 7881、UDP 3478 和 50000–60000；HTTPS 方案另需入口端口。\n'
[[ "$mode" != 1 && "$mode" != 4 ]] || printf '域名须解析到本机；放行 TCP 80/443。Cloudflare 首次申请证书先灰云。\n'
[[ "$mode" != 2 ]] || printf '放行 TCP %s；不要开放公网 7880/8080。\n' "$tls_port"
[[ "$mode" != 3 ]] || printf '内网还需放行 TCP 8080/7880，仅允许可信网络访问。\n'
yes '是否启动/更新以上服务？' || { printf '配置保留，服务未启动。\n';exit 0; }
if [[ "$mode" == 4 ]];then
  backup=''
  if [[ -e "$nginx_target" ]];then
    printf '已有站点文件：%s\n' "$nginx_target"
    yes '是否备份并替换此站点文件？' || die '未修改现有站点'
    backup="$nginx_target.backup-$(date +%s)"
    "${sudo_cmd[@]}" cp -- "$nginx_target" "$backup"
  fi
  "${sudo_cmd[@]}" cp -- "$generated" "$nginx_target"
  if ! "${sudo_cmd[@]}" nginx -t;then
    if [[ -n "$backup" ]];then "${sudo_cmd[@]}" cp -- "$backup" "$nginx_target";
    else "${sudo_cmd[@]}" mv -- "$nginx_target" "$DEPLOY_DIR/nginx/rejected-$(date +%s).conf";fi
    die 'Nginx 检查失败，本次站点修改已回滚，未启动服务'
  fi
fi
# Save identity before startup so a partial startup cannot be retried as a new stack.
printf 'MODE=%s\nPROJECT=%s\n' "$mode" "$project" > .quickshare-deploy
"${compose[@]}" up -d --build
if [[ "$mode" == 4 ]];then "${sudo_cmd[@]}" nginx -s reload;fi
step 6 '验证服务'
"${compose[@]}" ps
curl_args=(-fsS --connect-timeout 3 --max-time 5)
[[ "$mode" != 2 ]] || curl_args+=(--cacert "$DEPLOY_DIR/caddy/certs/server.crt")
healthy=false
for attempt in {1..15};do
  if curl "${curl_args[@]}" "$url/api/health" >/dev/null 2>&1;then healthy=true;break;fi
  sleep 2
done
$healthy || die "健康检查未通过，请检查 DNS/端口/证书；日志命令：docker compose -p $project -f $compose_file logs --tail=50"
escaped_auth=${auth//\\/\\\\};escaped_auth=${escaped_auth//\"/\\\"}
printf 'header = "Authorization: Bearer %s"\n' "$escaped_auth" | curl "${curl_args[@]}" --config - "$url/api/rooms" >/dev/null || die '健康接口正常，但房间接口失败，请检查 LiveKit 内部连接和密钥'
printf '\n部署成功。客户端地址：%s\n访问令牌在 %s/.env 的 AUTH_TOKEN 中。\n' "$url" "$DEPLOY_DIR"
[[ "$mode" != 2 ]] || printf '客户端需信任自签名证书；操作见 docs/IP自签名HTTPS部署.md。\n'
printf '再次运行此脚本可复用配置更新。升级聊天权限后，观众需退出并重新进入房间。\n'
