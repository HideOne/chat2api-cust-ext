import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chatStore'
import type { ChatAttachment } from '@/stores/chatStore'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { FileText, Paperclip, Send, Square, X } from 'lucide-react'

interface ChatInputProps {
  conversationId: string
}

export function ChatInput({ conversationId }: ChatInputProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopStreaming = useChatStore((s) => s.stopStreaming)

  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length === 0) return

      const nextAttachments = await Promise.all(
        files.map(async (file) => ({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          type: file.type.startsWith('image/') ? 'image' as const : 'file' as const,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
        }))
      )

      setAttachments((current) => [...current, ...nextAttachments])
      e.target.value = ''
    },
    [readFileAsDataUrl]
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }, [])

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if ((!trimmed && attachments.length === 0) || isStreaming) return
    setInput('')
    const sendingAttachments = attachments
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    await sendMessage(conversationId, trimmed, sendingAttachments)
  }, [input, attachments, isStreaming, conversationId, sendMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  return (
    <div className="border-t bg-background p-4">
      <div className="max-w-3xl mx-auto space-y-2">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center gap-2 h-9 max-w-[220px] rounded-md border bg-muted/40 px-2 text-xs"
              >
                {attachment.type === 'image' ? (
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="h-6 w-6 rounded object-cover"
                  />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{attachment.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => removeAttachment(attachment.id)}
                  disabled={isStreaming}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,.txt,.md,.json,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.js,.ts,.tsx,.jsx,.py,.java,.go,.rs,.cpp,.c,.h,.css,.html"
            onChange={handleFileChange}
            disabled={isStreaming}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 h-10 w-10"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.inputPlaceholder')}
            className="min-h-[40px] max-h-[200px] resize-none text-sm"
            rows={1}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <Button variant="destructive" size="icon" className="shrink-0 h-10 w-10" onClick={stopStreaming}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="shrink-0 h-10 w-10"
              onClick={handleSend}
              disabled={!input.trim() && attachments.length === 0}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
