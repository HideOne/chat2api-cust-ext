#!/bin/bash

# Chat2API 测试脚本
# 使用方法: ./test-api.sh [API_KEY] [BASE_URL]

API_KEY="${1:-}"
BASE_URL="${2:-http://127.0.0.1:8080}"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; }
info() { echo -e "  ${CYAN}ℹ INFO${NC} $1"; }

# 构造认证头
AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
  AUTH_HEADER="Authorization: Bearer $API_KEY"
fi

echo ""
echo "========================================="
echo "  Chat2API 接口测试"
echo "  地址: $BASE_URL"
echo "  Key:  ${API_KEY:-<未配置>}"
echo "========================================="
echo ""

TOTAL=0
PASSED=0

# ---------- 1. 健康检查 ----------
echo -e "${YELLOW}[1/5] 健康检查${NC}"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
TOTAL=$((TOTAL + 1))
if [ "$STATUS" = "200" ]; then
  pass "GET /health -> $STATUS"
  PASSED=$((PASSED + 1))
else
  fail "GET /health -> $STATUS (期望 200)"
fi

# ---------- 2. 根路径 ----------
echo -e "${YELLOW}[2/5] 根路径${NC}"
ROOT=$(curl -s "$BASE_URL/")
TOTAL=$((TOTAL + 1))
NAME=$(echo "$ROOT" | grep -o '"name":"[^"]*"' | head -1)
if echo "$NAME" | grep -q "Chat2API"; then
  pass "GET / -> 服务名称正确"
  PASSED=$((PASSED + 1))
  info "版本: $(echo "$ROOT" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"
else
  fail "GET / -> 响应异常: $ROOT"
fi

# ---------- 3. 模型列表 ----------
echo -e "${YELLOW}[3/5] 模型列表${NC}"
if [ -n "$AUTH_HEADER" ]; then
  MODELS=$(curl -s -H "$AUTH_HEADER" "$BASE_URL/v1/models")
else
  MODELS=$(curl -s "$BASE_URL/v1/models")
fi
TOTAL=$((TOTAL + 1))
MODEL_COUNT=$(echo "$MODELS" | grep -o '"id"' | wc -l | tr -d ' ')
if [ "$MODEL_COUNT" -gt 0 ]; then
  pass "GET /v1/models -> 获取到 $MODEL_COUNT 个模型"
  PASSED=$((PASSED + 1))
  # 提取前3个模型名
  echo "$MODELS" | grep -o '"id":"[^"]*"' | head -3 | while read line; do
    info "  模型: $(echo "$line" | cut -d'"' -f4)"
  done
else
  fail "GET /v1/models -> 无模型或请求失败"
  info "响应: $(echo "$MODELS" | head -c 200)"
fi

# ---------- 4. 非流式 Chat Completions ----------
echo -e "${YELLOW}[4/5] 非流式 Chat Completions${NC}"
# 取第一个模型名
FIRST_MODEL=$(echo "$MODELS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$FIRST_MODEL" ]; then
  fail "跳过 - 无可用模型"
  TOTAL=$((TOTAL + 1))
else
  TOTAL=$((TOTAL + 1))
  CHAT_BODY=$(cat <<EOF
{
  "model": "$FIRST_MODEL",
  "messages": [{"role": "user", "content": "Say hello in one word."}],
  "stream": false,
  "max_tokens": 50
}
EOF
)
  if [ -n "$AUTH_HEADER" ]; then
    CHAT_RESP=$(curl -s -w "\n%{http_code}" -H "Content-Type: application/json" -H "$AUTH_HEADER" -d "$CHAT_BODY" "$BASE_URL/v1/chat/completions")
  else
    CHAT_RESP=$(curl -s -w "\n%{http_code}" -H "Content-Type: application/json" -d "$CHAT_BODY" "$BASE_URL/v1/chat/completions")
  fi
  CHAT_STATUS=$(echo "$CHAT_RESP" | tail -1)
  CHAT_BODY_RESP=$(echo "$CHAT_RESP" | sed '$d')

  if [ "$CHAT_STATUS" = "200" ]; then
    CONTENT=$(echo "$CHAT_BODY_RESP" | grep -o '"content":"[^"]*"' | head -1)
    pass "POST /v1/chat/completions (非流式) -> $CHAT_STATUS"
    PASSED=$((PASSED + 1))
    info "模型: $FIRST_MODEL"
    info "回复: $(echo "$CONTENT" | cut -d'"' -f4 | head -c 100)"
  else
    fail "POST /v1/chat/completions (非流式) -> $CHAT_STATUS"
    info "响应: $(echo "$CHAT_BODY_RESP" | head -c 300)"
  fi
fi

# ---------- 5. 流式 Chat Completions ----------
echo -e "${YELLOW}[5/5] 流式 Chat Completions (SSE)${NC}"
if [ -z "$FIRST_MODEL" ]; then
  fail "跳过 - 无可用模型"
  TOTAL=$((TOTAL + 1))
else
  TOTAL=$((TOTAL + 1))
  STREAM_BODY=$(cat <<EOF
{
  "model": "$FIRST_MODEL",
  "messages": [{"role": "user", "content": "Count from 1 to 3."}],
  "stream": true,
  "max_tokens": 100
}
EOF
)
  if [ -n "$AUTH_HEADER" ]; then
    STREAM_RESP=$(curl -s --max-time 30 -H "Content-Type: application/json" -H "$AUTH_HEADER" -d "$STREAM_BODY" "$BASE_URL/v1/chat/completions")
  else
    STREAM_RESP=$(curl -s --max-time 30 -H "Content-Type: application/json" -d "$STREAM_BODY" "$BASE_URL/v1/chat/completions")
  fi

  CHUNK_COUNT=$(echo "$STREAM_RESP" | grep -c "^data: " || true)
  if [ "$CHUNK_COUNT" -gt 0 ]; then
    pass "POST /v1/chat/completions (流式) -> 收到 $CHUNK_COUNT 个 SSE 数据块"
    PASSED=$((PASSED + 1))
    # 拼接流式内容预览
    STREAM_CONTENT=$(echo "$STREAM_RESP" | grep '"content":"[^"]*"' | grep -o '"content":"[^"]*"' | sed 's/"content":"//g;s/"//g' | tr -d '\n' | head -c 200)
    info "流式内容预览: ${STREAM_CONTENT:-<空>}"
  else
    fail "POST /v1/chat/completions (流式) -> 无 SSE 数据"
    info "响应: $(echo "$STREAM_RESP" | head -c 300)"
  fi
fi

# ---------- 总结 ----------
echo ""
echo "========================================="
echo -e "  测试完成: ${GREEN}${PASSED}${NC}/${TOTAL} 通过"
echo "========================================="
echo ""

if [ "$PASSED" -eq "$TOTAL" ]; then
  exit 0
else
  exit 1
fi
