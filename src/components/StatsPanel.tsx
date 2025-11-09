import { Card } from './ui/card'
import { Progress } from './ui/progress'
import { Badge } from './ui/badge'
import { ScrollArea } from './ui/scroll-area'
import { AlertTriangle, Droplets, Clock, TrendingUp } from 'lucide-react'
import type { CauldronDto, CauldronLevelsDto } from '../types/api'
import type { Alert } from '../utils/realtimeMonitoring'

interface StatsPanelProps {
  selectedCauldron: string
  currentTime?: number
  cauldrons: CauldronDto[]
  currentLevels: CauldronLevelsDto | Record<string, number>
  alerts?: Alert[] // Active alerts for warning log
}

export default function StatsPanel({ selectedCauldron, cauldrons, currentLevels, alerts = [] }: StatsPanelProps) {
  const cauldron = cauldrons.find((c) => c.id === selectedCauldron)
  if (!cauldron || !cauldron.id) return null

  // Get current level from historical data
  const levelKey = `cauldron_${cauldron.id.split('_').pop()?.padStart(3, '0') || '001'}`
  const currentLevel = (currentLevels as any)[levelKey] || 0
  const percentage = (currentLevel / cauldron.max_volume) * 100
  const status = percentage > 80 ? 'critical' : percentage > 60 ? 'elevated' : 'safe'
  const statusColor = status === 'critical' ? 'destructive' : status === 'elevated' ? 'default' : 'secondary'

  // Estimate fill rate (simplified calculation)
  const estimatedFillRate = 2.5 // This could be calculated from historical data
  const timeToOverflow = ((cauldron.max_volume - currentLevel) / estimatedFillRate).toFixed(1)

  // Get alerts for this cauldron (filter out info level, sort by severity and timestamp)
  const cauldronAlerts = alerts
    .filter(a => a.cauldronId === cauldron.id && a.severity !== 'info')
    .sort((a, b) => {
      // Sort by severity first (critical > warning > info)
      const severityOrder = { critical: 3, warning: 2, info: 1 }
      const severityDiff = severityOrder[b.severity] - severityOrder[a.severity]
      if (severityDiff !== 0) return severityDiff
      // Then by timestamp (newest first)
      return b.timestamp.getTime() - a.timestamp.getTime()
    })
    .slice(0, 10) // Show last 10 warnings

  return (
    <Card className="p-6 border-border bg-card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Cauldron Details
        </h3>
        <Badge variant={statusColor as any} className="capitalize">
          {status}
        </Badge>
      </div>

      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{cauldron.name || cauldron.id || 'N/A'}</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground">ID</span>
            <span className="font-mono font-medium">{cauldron.id || 'N/A'}</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground">Location</span>
            <span className="font-medium">
              ({cauldron.latitude.toFixed(4)}, {cauldron.longitude.toFixed(4)})
            </span>
          </div>
        </div>

        <div className="pt-2 border-t border-border">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground flex items-center gap-2">
              <Droplets className="h-4 w-4" />
              Potion Level
            </span>
            <span className="font-medium">
              {currentLevel.toFixed(1)}L / {cauldron.max_volume}L
            </span>
          </div>
          <Progress value={percentage} className="h-2 purple" />
        </div>

        <div>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Max Capacity
            </span>
            <span className="font-medium">{cauldron.max_volume}L</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Estimated Time to Overflow
            </span>
            <span className="font-medium">{timeToOverflow} min</span>
          </div>
        </div>

        {percentage > 80 && (
          <div className="pt-3 border-t border-border">
            <div className="flex items-start gap-2 text-destructive text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span className="text-pretty">
                Warning: Cauldron approaching maximum capacity. Schedule pickup immediately.
              </span>
            </div>
          </div>
        )}

        {/* Warning Log */}
        {cauldronAlerts.length > 0 && (
          <div className="pt-3 border-t border-border">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              <h4 className="text-sm font-semibold">Active Warnings</h4>
              <Badge variant="outline" className="text-xs">
                {cauldronAlerts.length}
              </Badge>
            </div>
            <ScrollArea className="h-[200px] pr-2">
              <div className="space-y-2">
                {cauldronAlerts.map((alert) => {
                  const severityColors = {
                    critical: 'bg-red-500/20 border-red-500/50 text-red-300',
                    warning: 'bg-yellow-500/20 border-yellow-500/50 text-yellow-300',
                    info: 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                  }
                  
                  return (
                    <div
                      key={alert.id}
                      className={`p-2 rounded-lg border text-xs ${severityColors[alert.severity]}`}
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className={`h-3 w-3 mt-0.5 shrink-0 ${
                          alert.severity === 'critical' ? 'text-red-400' : 'text-yellow-400'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold mb-1">{alert.message}</div>
                          {alert.details?.reason && (
                            <div className="text-[10px] opacity-80 mb-1">
                              {alert.details.reason}
                            </div>
                          )}
                          <div className="text-[10px] opacity-60">
                            {alert.timestamp.toLocaleTimeString()}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </Card>
  )
}

