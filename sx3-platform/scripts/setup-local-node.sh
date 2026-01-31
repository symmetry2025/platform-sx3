#!/usr/bin/env bash
set -euo pipefail

# Установка Node.js в пользовательскую директорию внутри репозитория (без sudo).
# После установки можно временно добавить Node/pnpm в PATH текущей сессии:
#   source ./.tools/env.sh
#
# Параметры:
#   NODE_VERSION=20.11.1 ./scripts/setup-local-node.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${REPO_ROOT}/.tools"
NODE_DIR="${TOOLS_DIR}/node"
ENV_SH="${TOOLS_DIR}/env.sh"

NODE_VERSION="${NODE_VERSION:-20.11.1}"

arch="$(uname -m)"
case "${arch}" in
  x86_64) node_arch="x64" ;;
  aarch64|arm64) node_arch="arm64" ;;
  *)
    echo "ERROR: неподдерживаемая архитектура: ${arch} (ожидается x86_64 или aarch64/arm64)" >&2
    exit 2
    ;;
esac

platform="linux-${node_arch}"
tgz="node-v${NODE_VERSION}-${platform}.tar.xz"
url="https://nodejs.org/dist/v${NODE_VERSION}/${tgz}"
tmp="${TOOLS_DIR}/${tgz}"

mkdir -p "${TOOLS_DIR}"

desired_node_home="${NODE_DIR}"

# migrate legacy layout: .tools/node/node-vX.Y.Z-.../bin/node
if [[ ! -x "${desired_node_home}/bin/node" ]] && [[ -d "${desired_node_home}" ]]; then
  legacy="$(find "${desired_node_home}" -maxdepth 1 -type d -name 'node-v*-linux-*' | head -n 1 || true)"
  if [[ -n "${legacy}" ]] && [[ -x "${legacy}/bin/node" ]]; then
    tmp_migrate="${TOOLS_DIR}/.node-tmp-migrate"
    rm -rf "${tmp_migrate}"
    mv "${legacy}" "${tmp_migrate}"
    rm -rf "${desired_node_home}"
    mv "${tmp_migrate}" "${desired_node_home}"
    echo "OK: мигрировал Node layout в ${desired_node_home}"
  fi
fi

if [[ -x "${desired_node_home}/bin/node" ]]; then
  echo "OK: Node уже установлен: ${desired_node_home}/bin/node"
else
  echo "Downloading: ${url}"
  curl -fsSL "${url}" -o "${tmp}"
  rm -rf "${desired_node_home}"
  tar -xJf "${tmp}" -C "${TOOLS_DIR}"
  mv "${TOOLS_DIR}/node-v${NODE_VERSION}-${platform}" "${desired_node_home}"
  rm -f "${tmp}"
  echo "OK: Node установлен в ${desired_node_home}"
fi

cat > "${ENV_SH}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${REPO_ROOT}/.tools/node/bin:${PATH}"

if command -v node >/dev/null 2>&1; then
  node -v >/dev/null
fi
EOF
chmod +x "${ENV_SH}"

echo
echo "Дальше:"
echo "  source ./.tools/env.sh"
echo "  corepack enable"
echo "  corepack prepare pnpm@latest --activate"
echo "  pnpm install"

