/**
 * Forward Request File Logger
 * Persists all forwarded request/response data to local files, organized by date.
 */

import { homedir } from 'os'
import { join } from 'path'
import * as fs from 'fs'
import { Transform } from 'stream'
import type { ChatCompletionRequest } from '../types'
import type { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'

export interface ForwardLogEntry {
  requestId: string
  timestamp: number
  status: 'success' | 'error'
  latency: number
  providerId: string
  providerName: string
  accountId: string
  accountName: string
  model: string
  actualModel: string
  isStream: boolean
  clientRequest: ChatCompletionRequest
  forwardRequest: ChatCompletionRequest
  response?: {
    status?: number
    headers?: Record<string, string>
    body?: unknown
  }
  error?: string
}

class ForwardRequestLogger {
  private readonly baseDir: string

  constructor() {
    this.baseDir = join(homedir(), '.chat2api', 'forward-logs')
  }

  getLogDir(): string {
    return this.baseDir
  }

  isEnabled(): boolean {
    try {
      return storeManager.getConfig().enableForwardRequestLog === true
    } catch {
      return false
    }
  }

  private getDateDir(timestamp: number): string {
    const date = new Date(timestamp).toISOString().split('T')[0]
    return join(this.baseDir, date)
  }

  private formatFileName(timestamp: number, requestId: string): string {
    const timePart = new Date(timestamp).toISOString().replace(/[:.]/g, '-')
    const safeId = requestId.replace(/[^a-zA-Z0-9-_]/g, '_')
    return `${timePart}_${safeId}.json`
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  async saveLog(entry: ForwardLogEntry): Promise<string> {
    if (!this.isEnabled()) {
      return ''
    }

    const dateDir = this.getDateDir(entry.timestamp)
    this.ensureDir(dateDir)

    const filePath = join(dateDir, this.formatFileName(entry.timestamp, entry.requestId))
    const content = JSON.stringify(entry, null, 2)

    await fs.promises.writeFile(filePath, content, 'utf-8')
    return filePath
  }

  attachStreamLogger(
    stream: NodeJS.ReadableStream,
    entry: Omit<ForwardLogEntry, 'status' | 'response'> & {
      responseStatus?: number
      responseHeaders?: Record<string, string>
    }
  ): Transform {
    if (!this.isEnabled()) {
      const passthrough = new Transform({
        transform(chunk, _encoding, callback) {
          callback(null, chunk)
        },
      })
      stream.pipe(passthrough)
      return passthrough
    }

    const chunks: Buffer[] = []
    const logger = this

    const loggerTransform = new Transform({
      transform(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback(null, chunk)
      },
      flush(callback) {
        const responseBody = Buffer.concat(chunks).toString('utf-8')
        const logEntry: ForwardLogEntry = {
          ...entry,
          status: 'success',
          response: {
            status: entry.responseStatus,
            headers: entry.responseHeaders,
            body: responseBody,
          },
        }
        logger.saveLog(logEntry)
          .catch((error) => {
            console.error('[ForwardRequestLogger] Failed to save stream log:', error)
          })
          .finally(() => callback())
      },
    })

    loggerTransform.on('error', (error) => {
      const logEntry: ForwardLogEntry = {
        ...entry,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
      logger.saveLog(logEntry).catch((err) => {
        console.error('[ForwardRequestLogger] Failed to save stream error log:', err)
      })
    })

    stream.on('error', (error) => {
      loggerTransform.destroy(error instanceof Error ? error : new Error(String(error)))
    })

    stream.pipe(loggerTransform)
    return loggerTransform
  }

  buildLogEntry(params: {
    context: { requestId: string; model: string; actualModel?: string; isStream: boolean; startTime: number }
    account: Account
    provider: Provider
    actualModel: string
    clientRequest: ChatCompletionRequest
    forwardRequest: ChatCompletionRequest
    status: 'success' | 'error'
    latency: number
    response?: ForwardLogEntry['response']
    error?: string
  }): ForwardLogEntry {
    return {
      requestId: params.context.requestId,
      timestamp: params.context.startTime,
      status: params.status,
      latency: params.latency,
      providerId: params.provider.id,
      providerName: params.provider.name,
      accountId: params.account.id,
      accountName: params.account.name,
      model: params.context.model,
      actualModel: params.actualModel,
      isStream: params.context.isStream,
      clientRequest: params.clientRequest,
      forwardRequest: params.forwardRequest,
      response: params.response,
      error: params.error,
    }
  }
}

export const forwardRequestLogger = new ForwardRequestLogger()
