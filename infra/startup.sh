#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose
systemctl enable --now docker
sysctl -w vm.max_map_count=262144
printf 'vm.max_map_count=262144\n' > /etc/sysctl.d/99-outbox.conf
mkdir -p /opt/outbox
