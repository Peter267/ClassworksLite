import type { CSSProperties, HTMLAttributes } from 'react'

interface MdiIconProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  name: string
  size?: number
}

export function MdiIcon({ name, size = 24, className = '', style, ...rest }: MdiIconProps) {
  const merged: CSSProperties = { fontSize: size, width: size, height: size, ...style }
  return <i className={`mdi mdi-${name} ${className}`.trim()} aria-hidden="true" style={merged} {...rest} />
}
