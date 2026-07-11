#!/usr/bin/env bash
# =============================================================================
# NexusIDE — treino LiveKit WakeWord (PT-BR "Ei Jarvis") + re-embute no app
# =============================================================================
#
# Uso:
#   ./train_livekit.sh
#   ./train_livekit.sh --config configs/ei_jarvis_pt_smoke.yaml
#   ./train_livekit.sh --skip-setup          # se data/ já foi baixado
#   ./train_livekit.sh --export-only path/to/model.onnx
#   ./train_livekit.sh --stages generate,augment,train,export,eval
#
# Requer: Python 3.11+, livekit-wakeword[train,eval,export,voxcpm]
# GPU recomendada para o config de produção (ei_jarvis_pt.yaml).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

CONFIG="configs/ei_jarvis_pt.yaml"
SKIP_SETUP=0
EXPORT_ONLY=""
STAGES=""
RUN_DIR="${LIVEKIT_RUN_DIR:-$SCRIPT_DIR/livekit_run}"
ALSO_USER_OVERRIDE=1

usage() {
  cat <<'EOF'
NexusIDE — treino LiveKit WakeWord (PT-BR "Ei Jarvis") + re-embute no app

Uso:
  ./train_livekit.sh
  ./train_livekit.sh --config configs/ei_jarvis_pt_smoke.yaml
  ./train_livekit.sh --skip-setup
  ./train_livekit.sh --export-only path/to/model.onnx
  ./train_livekit.sh --stages generate,augment,train,export,eval
  ./train_livekit.sh --no-user-override
  ./train_livekit.sh --run-dir /tmp/lk-wake

Requer: Python 3.11+, livekit-wakeword[train,eval,export,voxcpm]
GPU recomendada para configs/ei_jarvis_pt.yaml (produção).
EOF
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --config)
      CONFIG="${2:?}"
      shift 2
      ;;
    --skip-setup)
      SKIP_SETUP=1
      shift
      ;;
    --export-only)
      EXPORT_ONLY="${2:?}"
      shift 2
      ;;
    --stages)
      STAGES="${2:?}"
      shift 2
      ;;
    --no-user-override)
      ALSO_USER_OVERRIDE=0
      shift
      ;;
    --run-dir)
      RUN_DIR="${2:?}"
      shift 2
      ;;
    *)
      echo "arg desconhecido: $1" >&2
      usage 1
      ;;
  esac
done

# Resolve config path
if [[ ! -f "$CONFIG" ]]; then
  if [[ -f "$SCRIPT_DIR/$CONFIG" ]]; then
    CONFIG="$SCRIPT_DIR/$CONFIG"
  else
    echo "config não encontrado: $CONFIG" >&2
    exit 1
  fi
fi
CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"

find_cli() {
  if command -v livekit-wakeword >/dev/null 2>&1; then
    echo "livekit-wakeword"
    return
  fi
  if command -v uv >/dev/null 2>&1; then
    # uvx run if package installed as tool
    if uv tool list 2>/dev/null | grep -q livekit-wakeword; then
      echo "uvx livekit-wakeword"
      return
    fi
  fi
  if python3 -c "import livekit.wakeword" 2>/dev/null; then
    echo "python3 -m livekit.wakeword"
    return
  fi
  return 1
}

reembed() {
  local onnx="$1"
  local extra=()
  if [[ "$ALSO_USER_OVERRIDE" -eq 1 ]]; then
    extra+=(--also-user-override)
  fi
  echo "==> re-embutindo no Nexus: $onnx"
  python3 "$SCRIPT_DIR/reembed_onnx.py" "$onnx" "${extra[@]}"
}

# --- export-only mode ---
if [[ -n "$EXPORT_ONLY" ]]; then
  reembed "$EXPORT_ONLY"
  exit 0
fi

CLI="$(find_cli || true)"
if [[ -z "${CLI:-}" ]]; then
  cat >&2 <<'EOF'
livekit-wakeword não encontrado.

Instale com um de:
  pip install 'livekit-wakeword[train,eval,export,voxcpm]'
  uv tool install 'livekit-wakeword[train,eval,export,voxcpm]'

Deps de sistema (macOS):
  brew install espeak-ng ffmpeg portaudio

Depois rode de novo:
  ./train_livekit.sh
EOF
  exit 1
fi

# shellcheck disable=SC2206
CLI_ARR=($CLI)

echo "==> CLI: ${CLI_ARR[*]}"
echo "==> config: $CONFIG"
echo "==> run dir: $RUN_DIR"

mkdir -p "$RUN_DIR"
# LiveKit usa data_dir/output_dir relativos ao cwd
cd "$RUN_DIR"
# config copiado para o run dir com paths relativos intactos
cp "$CONFIG" ./config.yaml
CONFIG_RUN="$(pwd)/config.yaml"

if [[ "$SKIP_SETUP" -eq 0 ]]; then
  echo "==> setup (modelos + backgrounds + RIRs + VoxCPM se necessário)"
  "${CLI_ARR[@]}" setup --config "$CONFIG_RUN"
else
  echo "==> skip setup"
fi

if [[ -n "$STAGES" ]]; then
  IFS=',' read -r -a STAGE_LIST <<< "$STAGES"
  for stage in "${STAGE_LIST[@]}"; do
    stage="$(echo "$stage" | xargs)"
    echo "==> stage: $stage"
    case "$stage" in
      generate|augment|train|export|eval)
        "${CLI_ARR[@]}" "$stage" "$CONFIG_RUN"
        ;;
      run)
        "${CLI_ARR[@]}" run "$CONFIG_RUN"
        ;;
      *)
        echo "stage desconhecido: $stage" >&2
        exit 1
        ;;
    esac
  done
else
  echo "==> pipeline completo (generate → augment → train → export → eval)"
  "${CLI_ARR[@]}" run "$CONFIG_RUN"
fi

# Localizar ONNX exportado
MODEL_NAME="$(
  python3 - <<'PY' "$CONFIG_RUN"
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
for line in text.splitlines():
    line = line.strip()
    if line.startswith("model_name:"):
        print(line.split(":", 1)[1].strip().strip("\"'"))
        break
else:
    print("model")
PY
)"

ONNX_CANDIDATES=(
  "$RUN_DIR/output/${MODEL_NAME}/${MODEL_NAME}.onnx"
  "$RUN_DIR/output/${MODEL_NAME}/model.onnx"
  "$RUN_DIR/output/${MODEL_NAME}.onnx"
)

ONNX=""
for c in "${ONNX_CANDIDATES[@]}"; do
  if [[ -f "$c" ]]; then
    ONNX="$c"
    break
  fi
done

if [[ -z "$ONNX" ]]; then
  # fallback: o .onnx mais recente sob output/
  ONNX="$(find "$RUN_DIR/output" -name '*.onnx' -type f -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
fi

if [[ -z "${ONNX:-}" || ! -f "$ONNX" ]]; then
  echo "erro: não achei ONNX exportado em $RUN_DIR/output" >&2
  echo "passe manualmente: ./train_livekit.sh --export-only path/to/model.onnx" >&2
  exit 1
fi

echo "==> ONNX encontrado: $ONNX"
reembed "$ONNX"

echo ""
echo "Pronto."
echo "  1. Reinicie o NexusIDE"
echo "  2. Log esperado: [wake] modelo PT-BR embutido carregado (sha=…)"
echo "  3. Commit resources/wake/ei-jarvis-ptbr.onnx + src/main/voice/wake-models-ptbr.ts"
echo "  4. Release → todos os PCs/OS recebem o head"
