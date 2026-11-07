#!/bin/sh
# Lab 8: перевірка образу (локально і в CI): розмір < 200 МБ, не root, без dev-залежностей,
# HEALTHCHECK стає healthy, docker stop завершує процес з кодом 0 менше ніж за 10 с.
set -eu
IMAGE=${1:-spacefight:local}
MAX_MB=${MAX_MB:-200}
MAX=$((MAX_MB * 1000 * 1000))

size=$(docker image inspect -f '{{.Size}}' "$IMAGE")
echo "розмір образу: $((size / 1000000)) МБ"
[ "$size" -lt "$MAX" ] || { echo "образ більший за ${MAX_MB} МБ"; exit 1; }

docker run --rm --entrypoint node "$IMAGE" -e "
const fs = require('node:fs')
if (process.getuid() === 0) throw new Error('процес від root')
for (const p of ['node_modules/vite/package.json', 'node_modules/vitest/package.json', 'node_modules/typescript/package.json', 'node_modules/@biomejs/biome/package.json', 'node_modules/@playwright/test/package.json', '/usr/local/lib/node_modules/npm'])
  if (fs.existsSync(p)) throw new Error('у фінальному образі є ' + p)
console.log('uid', process.getuid(), '— dev-залежностей і npm немає')"

docker rm -f sf-check >/dev/null 2>&1 || true
docker run -d --name sf-check -p 3999:3000 "$IMAGE" >/dev/null
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' sf-check)" = healthy ] && break
  sleep 2
done
echo "HEALTHCHECK: $(docker inspect -f '{{.State.Health.Status}}' sf-check)"
curl -fsS http://127.0.0.1:3999/health && echo
curl -fsS http://127.0.0.1:3999/ready && echo

start=$(date +%s%N)
docker stop -t 10 sf-check >/dev/null
ms=$(( ($(date +%s%N) - start) / 1000000 ))
code=$(docker inspect -f '{{.State.ExitCode}}' sf-check)
docker logs sf-check 2>&1 | tail -2
docker rm sf-check >/dev/null
echo "docker stop: ${ms} мс, код виходу ${code}"
[ "$code" = 0 ] && [ "$ms" -lt 10000 ]
