import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export type PillKind =
  | 'default'
  | 'good'
  | 'warn'
  | 'bad'
  | 'info'
  | 'purple'
  | 'teal'
  | 'accent'
  | 'soft'
  | 'task-call'
  | 'task-whatsapp'
  | 'task-info'
  | 'task-docs'
  | 'task-payment'
  | 'task-wait';

export interface PillProps {
  children: ReactNode;
  kind?: PillKind;
  icon?: ReactNode;
  className?: string;
}

/** Renders the Pill component. */
export function Pill({ children, kind = 'default', icon, className = '' }: PillProps) {
  return (
    <span className={['pill', kind === 'default' ? '' : 'pill-' + kind, className].filter(Boolean).join(' ')}>
      {icon}
      {children}
    </span>
  );
}

export type ButtonKind = 'primary' | 'soft' | 'ghost' | 'dark';

export interface KespButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: ButtonKind;
  size?: '' | 'sm' | 'lg';
  icon?: ReactNode;
}

/** Renders the Button component. */
export function Button({
  children,
  kind = 'soft',
  size = '',
  icon,
  type = 'button',
  className = '',
  ...rest
}: KespButtonProps) {
  const cls = `btn btn-${kind}${size ? ' btn-' + size : ''} ${className}`.trim();
  return (
    <button type={type} className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export interface SectionProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Renders the Section component. */
export function Section({ children, className = '', style }: SectionProps) {
  return (
    <section className={'rise ' + className} style={style}>
      {children}
    </section>
  );
}

export interface SparklineProps {
  data: number[];
  color?: string;
  w?: number;
  h?: number;
}

/** Renders the Sparkline component. */
export function Sparkline({ data, color = 'var(--accent)', w = 80, h = 28 }: SparklineProps) {
  if (!data || !data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data
    .map(/** Handles the callback for this operation. */(v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(' ');
  const area = `M0,${h} L${pts} L${w},${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={0.12} />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface ScoreRingProps {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
}

/** Renders the ScoreRing component. */
export function ScoreRing({ value, size = 84, stroke = 8, color }: ScoreRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const tone =
    color || (value >= 75 ? 'var(--good)' : value >= 60 ? 'var(--warn)' : 'var(--bad)');
  return (
    <span className="score-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--bg-sunk)"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={tone}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          strokeLinecap="round"
        />
      </svg>
      <span className="num">
        {value.toFixed(1)}
        <small>/100</small>
      </span>
    </span>
  );
}
