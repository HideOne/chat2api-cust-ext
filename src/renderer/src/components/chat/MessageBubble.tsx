import type { Message } from '@/stores/chatStore'
import { MarkdownRenderer } from './MarkdownRenderer'
import { StreamingIndicator } from './StreamingIndicator'
import { FileText } from 'lucide-react'

interface MessageBubbleProps {
  message: Message
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'
  const isError = message.status === 'error'

  const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : isError
              ? 'bg-destructive/10 border border-destructive/30 text-foreground'
              : 'bg-muted text-foreground'
        }`}
      >
        {/* Assistant label */}
        {!isUser && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground">{message.model}</span>
          </div>
        )}

        {/* Content */}
        {isUser && message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 grid gap-2">
            {message.attachments.map((attachment) => (
              attachment.type === 'image' ? (
                <img
                  key={attachment.id}
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="max-h-56 max-w-full rounded-md object-contain"
                />
              ) : (
                <div
                  key={attachment.id}
                  className="flex items-center gap-2 rounded-md bg-primary-foreground/10 px-2 py-1.5 text-xs"
                >
                  <FileText className="h-4 w-4 shrink-0" />
                  <span className="truncate">{attachment.name}</span>
                </div>
              )
            ))}
          </div>
        )}

        {isUser ? (
          message.content ? (
            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
          ) : null
        ) : message.content ? (
          <MarkdownRenderer content={message.content} />
        ) : isStreaming ? (
          <StreamingIndicator />
        ) : null}

        {/* Streaming indicator after content */}
        {!isUser && message.content && isStreaming && <StreamingIndicator />}

        {/* Error */}
        {isError && message.error && (
          <p className="text-xs text-destructive mt-2">{message.error}</p>
        )}

        {/* Timestamp */}
        <p className={`text-[10px] mt-1 ${isUser ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>
          {timeStr}
        </p>
      </div>
    </div>
  )
}
