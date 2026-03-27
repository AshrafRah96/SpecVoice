import { cn } from '@/lib/utils'

interface OrbProps {
  state: 'idle' | 'listening' | 'talking'
  className?: string
}

export function Orb({ state, className }: OrbProps) {
  const isActive = state !== 'idle'

  return (
    <div className={cn('relative flex items-center justify-center w-16 h-16', className)}>
      {/* Primary expanding ring — active when listening or talking */}
      {isActive && (
        <span
          className="absolute inset-0 rounded-full border border-foreground/30 animate-orbRing"
          aria-hidden
        />
      )}
      {/* Second ring, delayed — only when talking */}
      {state === 'talking' && (
        <span
          className="absolute inset-0 rounded-full border border-foreground/15 animate-orbRing"
          style={{ animationDelay: '0.6s' }}
          aria-hidden
        />
      )}
      {/* Core sphere */}
      <div
        className={cn(
          'w-10 h-10 rounded-full transition-all duration-700',
          'bg-gradient-to-br from-foreground/20 via-foreground/8 to-transparent',
          isActive
            ? 'opacity-100 shadow-[0_0_18px_2px_hsl(var(--foreground)/0.08)]'
            : 'animate-orbPulse opacity-50'
        )}
      />
    </div>
  )
}
