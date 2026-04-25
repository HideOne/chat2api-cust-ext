import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chatStore'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ModelSelectorProps {
  model: string
  onModelChange: (model: string) => void
}

export function ModelSelector({ model, onModelChange }: ModelSelectorProps) {
  const { t } = useTranslation()
  const models = useChatStore((s) => s.models)

  // Group models by provider
  const grouped = models.reduce<Record<string, typeof models>>((acc, m) => {
    const owner = m.owned_by || 'Other'
    if (!acc[owner]) acc[owner] = []
    acc[owner].push(m)
    return acc
  }, {})

  return (
    <Select value={model} onValueChange={onModelChange}>
      <SelectTrigger className="w-[220px] h-8 text-xs">
        <SelectValue placeholder={t('chat.selectModel')} />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(grouped).map(([owner, items]) => (
          <SelectGroup key={owner}>
            <SelectLabel className="text-xs text-muted-foreground">{owner}</SelectLabel>
            {items.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                {m.id}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
