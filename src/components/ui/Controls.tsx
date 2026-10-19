import type { ReactNode } from 'react'

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  hint?: ReactNode
  disabled?: boolean
}

/** 设置项行：左侧标题+说明，右侧开关 */
export function SwitchRow({ checked, onChange, label, hint, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-4 py-2.5 text-left disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium leading-snug">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[12.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
            {hint}
          </span>
        )}
      </span>
      <span className="switch" data-on={checked} aria-hidden="true" />
    </button>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  label?: ReactNode
  hint?: ReactNode
}

export function SegmentedRow<T extends string>({
  value,
  options,
  onChange,
  label,
  hint,
}: SegmentedProps<T>) {
  return (
    <div className="py-2.5">
      {label && (
        <div className="mb-2">
          <div className="text-[14px] font-medium">{label}</div>
          {hint && (
            <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-3)' }}>
              {hint}
            </div>
          )}
        </div>
      )}
      <div
        className="inline-flex rounded-[12px] p-1"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
      >
        {options.map((option) => {
          const active = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className="rounded-[9px] px-3.5 py-1.5 text-[13px] font-medium transition-colors"
              style={
                active
                  ? { background: 'var(--primary)', color: 'var(--primary-ink)' }
                  : { color: 'var(--text-2)' }
              }
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface RangeRowProps {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  label: ReactNode
  hint?: ReactNode
  onChange: (next: number) => void
}

export function RangeRow({ value, min, max, step = 1, unit, label, hint, onChange }: RangeRowProps) {
  return (
    <div className="py-2.5">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium">{label}</div>
          {hint && (
            <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-3)' }}>
              {hint}
            </div>
          )}
        </div>
        <div
          className="shrink-0 text-[13px] font-semibold tabular-nums"
          style={{ color: 'var(--primary)' }}
        >
          {value}
          {unit}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, var(--primary) ${
            ((value - min) / (max - min)) * 100
          }%, var(--surface-3) ${((value - min) / (max - min)) * 100}%)`,
        }}
      />
    </div>
  )
}

interface TextRowProps {
  value: string
  label: ReactNode
  hint?: ReactNode
  placeholder?: string
  onChange: (next: string) => void
  type?: string
}

export function TextRow({ value, label, hint, placeholder, onChange, type = 'text' }: TextRowProps) {
  return (
    <label className="block py-2.5">
      <span className="block text-[14px] font-medium">{label}</span>
      {hint && (
        <span className="mt-0.5 block text-[12.5px]" style={{ color: 'var(--text-3)' }}>
          {hint}
        </span>
      )}
      <input
        type={type}
        className="field mt-2"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
