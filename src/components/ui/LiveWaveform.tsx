import { cn } from '@/lib/utils'

interface LiveWaveformProps {
  active: boolean
  bars?: number
  className?: string
}

export function LiveWaveform({ active, bars = 10, className }: LiveWaveformProps) {
  return (
    <div className={cn('flex items-end gap-[2px]', className)} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn(
            'w-[3px] rounded-full bg-muted-foreground/50 transition-all duration-300',
            active ? 'animate-waveBar' : 'h-[4px]'
          )}
          style={active ? { animationDelay: `${i * 70}ms` } : undefined}
        />
      ))}
    </div>
  )
}
