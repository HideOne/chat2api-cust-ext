/**
 * Proxy Service Module - Anthropic Messages API Route
 * Implements POST /v1/messages (Anthropic Messages API compatible)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { ProxyContext } from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import {
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  createAnthropicErrorResponse,
  AnthropicStreamTransformer,
} from '../utils/anthropicConverter'

const router = new Router({ prefix: '/v1' })

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `msg_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * POST /v1/messages — Anthropic Messages API compatible endpoint
 */
router.post('/messages', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  // Parse request
  let anthropicRequest: any
  try {
    anthropicRequest = ctx.request.body
  } catch {
    ctx.status = 400
    ctx.body = createAnthropicErrorResponse('invalid_request_error', 'Invalid request body')
    return
  }

  // Validate required fields
  if (!anthropicRequest.model) {
    ctx.status = 400
    ctx.body = createAnthropicErrorResponse('invalid_request_error', 'Missing required field: model')
    return
  }

  if (!anthropicRequest.messages || !Array.isArray(anthropicRequest.messages) || anthropicRequest.messages.length === 0) {
    ctx.status = 400
    ctx.body = createAnthropicErrorResponse('invalid_request_error', 'Missing required field: messages')
    return
  }

  // Convert Anthropic request to OpenAI format
  const openaiRequest = convertAnthropicToOpenAI(anthropicRequest)
  const requestedModel = anthropicRequest.model
  const isStream = anthropicRequest.stream === true

  console.log(`[Messages] ${requestId} model=${requestedModel} stream=${isStream}`)

  // Select account via load balancer
  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(requestedModel)
  const preferredAccountId = modelMapper.getPreferredAccount(requestedModel)

  const selection = loadBalancer.selectAccount(
    requestedModel,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = createAnthropicErrorResponse(
      'service_unavailable_error',
      `No available account for model: ${requestedModel}`
    )
    return
  }

  const { account, provider, actualModel } = selection

  const context: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: requestedModel,
    actualModel,
    startTime,
    isStream,
    clientIP,
  }

  proxyStatusManager.recordRequestStart(requestedModel, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      openaiRequest,
      account,
      provider,
      actualModel,
      context
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      if (result.status && result.status >= 400 && result.status !== 429) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      ctx.body = createAnthropicErrorResponse('api_error', result.error || 'Request failed')

      storeManager.addLog('error', `[Messages] Request failed: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: requestedModel,
        latency,
      })

      return
    }

    loadBalancer.clearAccountFailure(account.id)
    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    storeManager.addLog('info', `[Messages] Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: requestedModel,
      actualModel,
      latency,
      isStream,
    })

    if (isStream && result.stream) {
      // Streaming response: convert OpenAI SSE to Anthropic SSE
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const transformer = new AnthropicStreamTransformer(requestedModel)
      const wrapperStream = new PassThrough()

      result.stream.pipe(transformer).pipe(wrapperStream)
      ctx.body = wrapperStream
    } else {
      // Non-streaming response: convert to Anthropic format
      ctx.set('Content-Type', 'application/json')

      if (result.body) {
        // Handle case where skipTransform is true and body is already in OpenAI format
        const openaiBody = result.skipTransform ? result.body : result.body
        ctx.body = convertOpenAIToAnthropic(openaiBody, requestedModel)
      } else {
        // Empty response
        ctx.body = {
          id: `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: requestedModel,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    ctx.status = 500
    ctx.body = createAnthropicErrorResponse('internal_error', errorMessage)

    storeManager.addLog('error', `[Messages] Request exception: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: requestedModel,
      latency,
      error: errorMessage,
    })
  }
})

export default router
