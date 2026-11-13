#!/usr/bin/env bash
set -euo pipefail

# Antigravity-Autoloop 本地插件安全挂载/卸载脚本
# 仅在插件目录维护 <targetDir>/autoloop -> <repoRoot> 符号链接；
# 严禁读写用户全局 config.json，也绝不覆盖或删除真实目录/文件。

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

TARGET_DIR="${AUTOLOOP_PLUGINS_DIR:-${HOME}/.gemini/config/plugins}"
DRY_RUN=0
UNINSTALL=0

print_usage() {
  cat <<'EOF'
用法: scripts/install-local-plugin.sh [选项]

选项:
  --target-dir <dir>   指定插件挂载父目录（优先级高于 AUTOLOOP_PLUGINS_DIR，默认 $HOME/.gemini/config/plugins）
  --dry-run            仅演练并输出将执行的检查与动作，不写入文件系统
  --uninstall          安全移除 <target-dir>/autoloop 符号链接（非符号链接拒绝删除）
  -h, --help           显示此帮助信息
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "错误: --target-dir 缺少目录参数。" >&2
        exit 2
      fi
      TARGET_DIR="$2"
      shift 2
      ;;
    --target-dir=*)
      TARGET_DIR="${1#--target-dir=}"
      if [ -z "$TARGET_DIR" ]; then
        echo "错误: --target-dir 不能为空。" >&2
        exit 2
      fi
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "错误: 未知参数 '$1'。" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

# 规范化去掉末尾多余斜杠
if [ "$TARGET_DIR" != "/" ]; then
  TARGET_DIR="${TARGET_DIR%/}"
fi
if [ "$TARGET_DIR" = "/" ]; then
  LINK_PATH="/autoloop"
else
  LINK_PATH="${TARGET_DIR}/autoloop"
fi

verify_repo_integrity() {
  local required_files=(
    "sidecars/hub/sidecar.json"
    "mcp_config.json"
    "hooks.json"
  )
  local rel
  for rel in "${required_files[@]}"; do
    if [ ! -f "${REPO_ROOT}/${rel}" ]; then
      echo "错误: 仓库根目录 (${REPO_ROOT}) 缺少关键插件清单文件: ${rel}" >&2
      exit 1
    fi
  done
}

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -L "$LINK_PATH" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] 将移除符号链接: ${LINK_PATH}"
    else
      rm -- "$LINK_PATH"
      echo "已完成卸载：已安全移除插件符号链接 ${LINK_PATH}"
    fi
    exit 0
  elif [ -e "$LINK_PATH" ]; then
    echo "安全中止: ${LINK_PATH} 是真实目录或文件而非符号链接，为保护用户数据已拒绝删除。" >&2
    exit 1
  else
    echo "无需操作: 插件路径 ${LINK_PATH} 不存在（已处于未安装状态）。"
    exit 0
  fi
fi

verify_repo_integrity

if [ -L "$LINK_PATH" ]; then
  CURRENT_TARGET="$(readlink "$LINK_PATH" || true)"
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$CURRENT_TARGET" = "$REPO_ROOT" ]; then
      echo "[dry-run] 符号链接已指向当前仓库（幂等保持）: ${LINK_PATH} -> ${REPO_ROOT}"
    else
      echo "[dry-run] 将幂等更新符号链接: ${LINK_PATH} (${CURRENT_TARGET:-unknown}) -> ${REPO_ROOT}"
    fi
    exit 0
  fi
  if [ "$CURRENT_TARGET" != "$REPO_ROOT" ]; then
    rm -- "$LINK_PATH"
    ln -s -- "$REPO_ROOT" "$LINK_PATH"
    ACTION_DESC="已幂等更新插件符号链接"
  else
    ACTION_DESC="插件符号链接已存在且指向一致（幂等跳过覆写）"
  fi
elif [ -e "$LINK_PATH" ]; then
  echo "安全中止: ${LINK_PATH} 已存在真实目录或普通文件（非符号链接），已拒绝覆盖或删除，请先人工备份迁移。" >&2
  exit 1
else
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] 将创建目录 ${TARGET_DIR} 并建立符号链接: ${LINK_PATH} -> ${REPO_ROOT}"
    exit 0
  fi
  mkdir -p -- "$TARGET_DIR"
  ln -s -- "$REPO_ROOT" "$LINK_PATH"
  ACTION_DESC="已完成插件符号链接安装"
fi

cat <<EOF
${ACTION_DESC}:
  ${LINK_PATH} -> ${REPO_ROOT}

后续操作说明（可在 Antigravity 聊天/面板直接点击）:
- 打开插件管理与启用开关: [autoloop](customization://autoloop)
- 打开内置 Hub 控制面板: [Autoloop 工作台](sidecar://autoloop/hub/)
- 提示: 本脚本仅维护符号链接，未改动任何全局设置或注册文件；如需移除请运行 --uninstall。
EOF
