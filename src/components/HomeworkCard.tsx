import { memo } from 'react'
import { useSetting } from '../lib/hooks'
import { Icon } from './Icon'

interface HomeworkCardProps {
  name: string
  content: string
  /** 自定义卡片使用右上角图标与主色标题 */
  custom?: boolean
  highlighted?: boolean
  disabled?: boolean
  onOpen: () => void
}

function splitLines(content: string): string[] {
  return content.split('\n').filter((line) => line.trim())
}

function trackGlow(event: React.MouseEvent<HTMLElement>) {
  const card = event.currentTarget
  const rect = card.getBoundingClientRect()
  card.style.setProperty('--x', `${((event.clientX - rect.left) / rect.width) * 100}%`)
  card.style.setProperty('--y', `${((event.clientY - rect.top) / rect.height) * 100}%`)
}

function trackGlowTouch(event: React.TouchEvent<HTMLElement>) {
  if (event.touches.length !== 1) return
  const touch = event.touches[0]
  const card = event.currentTarget
  const rect = card.getBoundingClientRect()
  card.style.setProperty('--x', `${((touch.clientX - rect.left) / rect.width) * 100}%`)
  card.style.setProperty('--y', `${((touch.clientY - rect.top) / rect.height) * 100}%`)
}

/** 作业卡片：v-card + v-card-title + v-list（对齐 HomeworkGrid.vue） */
export const HomeworkCard = memo(function HomeworkCard({
  name,
  content,
  custom,
  highlighted,
  disabled,
  onOpen,
}: HomeworkCardProps) {
  const [fontSize] = useSetting<number>('font.size')
  const lines = splitLines(content)

  if (custom) {
    return (
      <article
        className={`v-card border rounded-xl glow-track ${
          highlighted ? 'glow-highlight' : ''
        } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        onClick={() => {
          if (!disabled) onOpen()
        }}
        onMouseMove={trackGlow}
        onTouchMove={trackGlowTouch}
      >
        <div className="v-card-title text-primary">
          <Icon name="cardText" size={18} className="mr-2" />
          <span className="text-truncate">{name}</span>
        </div>
        <div
          className="v-card-text"
          style={{ fontSize, whiteSpace: 'pre-wrap', lineHeight: 1.6, overflowWrap: 'anywhere' }}
        >
          {content}
        </div>
      </article>
    )
  }

  return (
    <article
      className={`v-card border rounded-xl glow-track ${
        highlighted ? 'glow-highlight' : ''
      } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      onClick={() => {
        if (!disabled) onOpen()
      }}
      onMouseMove={trackGlow}
      onTouchMove={trackGlowTouch}
    >
      <div className="v-card-title">{name}</div>
      <div className="v-card-text" style={{ fontSize }}>
        <div className="v-list">
          {lines.map((line, index) => (
            <div
              className="v-list-item homework-line"
              key={`${index}-${line}`}
              style={{ minHeight: 32 }}
            >
              <div
                className="v-list-item-title"
                style={{ lineHeight: 1.55, fontSize, overflowWrap: 'anywhere' }}
              >
                {line}
              </div>
            </div>
          ))}
        </div>
      </div>
    </article>
  )
})

interface EmptySubjectProps {
  name: string
  variant: 'card' | 'button' | 'chip'
  animationClass?: string
  disabled?: boolean
  onOpen: () => void
}

/** 无作业科目：移动端 chip / 按钮组 / 卡片（对齐 display.emptySubjectDisplay） */
export function EmptySubjectCard({
  name,
  variant,
  animationClass = '',
  disabled,
  onOpen,
}: EmptySubjectProps) {
  if (variant === 'chip') {
    return (
      <button
        type="button"
        className={`v-chip v-chip--variant-tonal ${animationClass}`}
        data-color="primary"
        style={{ margin: 4, cursor: 'pointer', border: 'none' }}
        onClick={onOpen}
      >
        <Icon name={disabled ? 'close' : 'plus'} size={16} />
        {name}
      </button>
    )
  }

  if (variant === 'button') {
    return (
      <button
        type="button"
        className={`v-btn v-btn--variant-tonal ${animationClass}`}
        data-color="primary"
        style={{ borderRadius: 0 }}
        disabled={disabled}
        onClick={onOpen}
      >
        <Icon name={disabled ? 'close' : 'plus'} size={18} />
        {name}
      </button>
    )
  }

  return (
    <button
      type="button"
      className={`v-card border rounded-xl empty-subject-card ${animationClass}`}
      style={{ textAlign: 'left', padding: 0 }}
      disabled={disabled}
      onClick={onOpen}
    >
      <div className="v-card-title text-subtitle-1">{name}</div>
      <div className="v-card-text text-center">
        <Icon name={disabled ? 'close' : 'plus'} size={18} className="text-grey" />
        <div className="text-caption text-grey">{disabled ? '当日无作业' : '点击添加作业'}</div>
      </div>
    </button>
  )
}
