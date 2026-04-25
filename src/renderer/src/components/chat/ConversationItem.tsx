import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, type Conversation } from '@/stores/chatStore'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

interface ConversationItemProps {
  conversation: Conversation
  isActive: boolean
}

export function ConversationItem({ conversation, isActive }: ConversationItemProps) {
  const { t } = useTranslation()
  const setActive = useChatStore((s) => s.setActiveConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(conversation.title)

  const handleRename = () => {
    if (renameValue.trim()) {
      renameConversation(conversation.id, renameValue.trim())
    }
    setIsRenaming(false)
  }

  const timeStr = (() => {
    const now = Date.now()
    const diff = now - conversation.updatedAt
    const days = Math.floor(diff / 86400000)
    if (days === 0) return t('chat.today')
    if (days === 1) return t('chat.yesterday')
    if (days < 30) return t('chat.daysAgo', { count: days })
    return new Date(conversation.updatedAt).toLocaleDateString()
  })()

  if (isRenaming) {
    return (
      <div className="px-2 py-1.5">
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') setIsRenaming(false)
          }}
          className="h-7 text-xs"
          autoFocus
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer text-sm transition-colors',
        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
      )}
      onClick={() => setActive(conversation.id)}
    >
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm">
          {conversation.title || t('chat.untitled')}
        </p>
        <p className="text-[10px] text-muted-foreground">{timeStr}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              setRenameValue(conversation.title)
              setIsRenaming(true)
            }}
          >
            <Pencil className="h-3.5 w-3.5 mr-2" />
            {t('chat.renameConversation')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              deleteConversation(conversation.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            {t('chat.deleteConversation')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
