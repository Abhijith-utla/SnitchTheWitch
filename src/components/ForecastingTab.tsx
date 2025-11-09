import { useState, useEffect, useMemo } from 'react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Slider } from './ui/slider'
import { RefreshCw, AlertTriangle, CheckCircle, Clock, Calendar, Play, Pause } from 'lucide-react'
import { apiService } from '../services/api'
import type { CauldronDto, HistoricalDataDto } from '../types/api'

interface ForecastingTabProps {
  cauldrons: CauldronDto[]
  historicalData?: HistoricalDataDto[]
  dataStartTime?: number
  dataEndTime?: number
}

interface CauldronForecast {
  cauldronId: string
  cauldronName: string
  currentLevel: number
  maxVolume: number
  fillRate: number // liters per minute
  timeUntilOverflow: number // minutes
  riskLevel: 'low' | 'medium' | 'high'
  overflowTimestamp: Date
}

// Convert cauldron ID to the format used in cauldron_levels (e.g., "cauldron_001")
export function getCauldronKey(cauldronId: string): string {
  const num = cauldronId.split('_').pop()?.padStart(3, '0') || '001'
  return `cauldron_${num}`
}

// Calculate fill rate by ignoring drain events
export function calculateFillRate(
  historicalData: HistoricalDataDto[],
  cauldronKey: string
): number {
  const fillRates: number[] = []
  
  for (let i = 1; i < historicalData.length; i++) {
    const prevPoint = historicalData[i - 1]
    const currPoint = historicalData[i]
    
    if (!prevPoint?.timestamp || !currPoint?.timestamp) continue
    
    const prevLevel = (prevPoint.cauldron_levels as any)?.[cauldronKey] || 0
    const currLevel = (currPoint.cauldron_levels as any)?.[cauldronKey] || 0
    const prevTime = new Date(prevPoint.timestamp).getTime()
    const currTime = new Date(currPoint.timestamp).getTime()
    
    if (isNaN(prevTime) || isNaN(currTime)) continue
    
    const timeDiff = (currTime - prevTime) / (1000 * 60) // minutes
    const levelDiff = currLevel - prevLevel
    
    // Only consider periods where level increased (filling) and time difference is reasonable
    // Ignore drain events (rapid decreases)
    if (levelDiff > 0 && timeDiff > 0 && timeDiff < 60) { // Max 1 hour between points
      const rate = levelDiff / timeDiff // liters per minute
      if (rate > 0) {
        fillRates.push(rate)
      }
    }
  }
  
  // Use median for robustness
  if (fillRates.length === 0) return 0.01 // Default small rate
  
  fillRates.sort((a, b) => a - b)
  const medianIndex = Math.floor(fillRates.length / 2)
  const median = fillRates.length % 2 === 0
    ? (fillRates[medianIndex - 1] + fillRates[medianIndex]) / 2
    : fillRates[medianIndex]
  
  return Math.max(0.001, median) // Ensure positive rate
}

// Predict time until overflow
export function predictTimeUntilOverflow(
  currentLevel: number,
  maxVolume: number,
  fillRate: number
): number {
  if (fillRate <= 0) return Infinity
  const remainingCapacity = maxVolume - currentLevel
  if (remainingCapacity <= 0) return 0
  return remainingCapacity / fillRate // minutes
}

export default function ForecastingTab({
  cauldrons,
  historicalData: initialHistoricalData,
  dataStartTime,
  dataEndTime
}: ForecastingTabProps) {
  const [allHistoricalData, setAllHistoricalData] = useState<HistoricalDataDto[]>(initialHistoricalData || [])
  const [loading, setLoading] = useState(!initialHistoricalData)
  const [forecasts, setForecasts] = useState<CauldronForecast[]>([])
  const [timeRangeDays, setTimeRangeDays] = useState<number>(7) // Default to 7 days
  
  // Simulation timeline state
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1) // 1x, 5x, 10x, 20x
  const [simulationTime, setSimulationTime] = useState<number | null>(null) // Current simulation time in milliseconds
  
  // Calculate total time span
  const timeSpan = useMemo(() => {
    if (!dataStartTime || !dataEndTime) return null
    return {
      start: dataStartTime,
      end: dataEndTime,
      totalMs: dataEndTime - dataStartTime,
      totalMinutes: Math.floor((dataEndTime - dataStartTime) / (1000 * 60))
    }
  }, [dataStartTime, dataEndTime])
  
  // Initialize simulation time to end time (most recent)
  useEffect(() => {
    if (timeSpan && simulationTime === null) {
      setSimulationTime(timeSpan.end)
    }
  }, [timeSpan, simulationTime])
  
  // Filter historical data based on selected time range AND simulation time
  const historicalData = useMemo(() => {
    if (allHistoricalData.length === 0) return []
    
    // Get the cutoff time based on time range slider
    const lastTimestamp = simulationTime !== null 
      ? simulationTime 
      : new Date(allHistoricalData[allHistoricalData.length - 1].timestamp).getTime()
    const cutoffTime = lastTimestamp - (timeRangeDays * 24 * 60 * 60 * 1000) // Subtract days in milliseconds
    
    // Also filter by simulation time (only show data up to current simulation time)
    const simulationCutoff = simulationTime !== null ? simulationTime : Infinity
    
    return allHistoricalData.filter(point => {
      const pointTime = new Date(point.timestamp).getTime()
      return pointTime >= cutoffTime && pointTime <= simulationCutoff
    })
  }, [allHistoricalData, timeRangeDays, simulationTime])
  
  // Simulation playback effect
  useEffect(() => {
    if (!isPlaying || !timeSpan || simulationTime === null) return
    
    // Update every 100ms, advancing by playbackSpeed minutes per second of real time
    // So: playbackSpeed minutes per second = (playbackSpeed * 60 * 1000) ms per second
    // Per 100ms interval: (playbackSpeed * 60 * 1000) / 10 = playbackSpeed * 6 * 1000 ms
    const interval = setInterval(() => {
      setSimulationTime(prev => {
        if (prev === null) return timeSpan.end
        const advanceMs = (playbackSpeed * 60 * 1000) / 10 // playbackSpeed minutes per second, divided by 10 intervals per second
        const nextTime = prev + advanceMs
        if (nextTime >= timeSpan.end) {
          setIsPlaying(false) // Stop at end
          return timeSpan.end
        }
        return nextTime
      })
    }, 100) // Update every 100ms (10 times per second)
    
    return () => clearInterval(interval)
  }, [isPlaying, playbackSpeed, timeSpan, simulationTime])

  // Fetch historical data if not provided
  useEffect(() => {
    if (!initialHistoricalData && dataStartTime && dataEndTime) {
      setLoading(true)
      apiService.getHistoricalData(dataStartTime, dataEndTime)
        .then(data => {
          setAllHistoricalData(data)
          setLoading(false)
        })
        .catch(err => {
          console.error('Failed to fetch historical data:', err)
          setLoading(false)
        })
    } else if (initialHistoricalData) {
      setAllHistoricalData(initialHistoricalData)
    }
  }, [initialHistoricalData, dataStartTime, dataEndTime])

  // Calculate forecasts for all cauldrons
  useEffect(() => {
    if (historicalData.length === 0 || cauldrons.length === 0) {
      setForecasts([])
      return
    }

    const newForecasts: CauldronForecast[] = []

    cauldrons.forEach(cauldron => {
      if (!cauldron.id) return

      const cauldronKey = getCauldronKey(cauldron.id)
      
      // Get current level (most recent data point)
      const lastDataPoint = historicalData[historicalData.length - 1]
      const currentLevel = lastDataPoint
        ? ((lastDataPoint.cauldron_levels as any)?.[cauldronKey] || 0)
        : 0

      // Calculate fill rate (ignoring drain events)
      const fillRate = calculateFillRate(historicalData, cauldronKey)

      // Predict time until overflow
      const timeUntilOverflow = predictTimeUntilOverflow(
        currentLevel,
        cauldron.max_volume,
        fillRate
      )

      // Determine risk level
      let riskLevel: 'low' | 'medium' | 'high'
      if (timeUntilOverflow < 4 * 60) { // Less than 4 hours
        riskLevel = 'high'
      } else if (timeUntilOverflow < 8 * 60) { // Less than 8 hours
        riskLevel = 'medium'
      } else {
        riskLevel = 'low'
      }

      // Calculate overflow timestamp
      const overflowTimestamp = new Date()
      overflowTimestamp.setMinutes(overflowTimestamp.getMinutes() + timeUntilOverflow)

      newForecasts.push({
        cauldronId: cauldron.id,
        cauldronName: cauldron.name || cauldron.id,
        currentLevel,
        maxVolume: cauldron.max_volume,
        fillRate,
        timeUntilOverflow,
        riskLevel,
        overflowTimestamp
      })
    })

    // Sort by cauldron number (1-12) to keep them in the same place
    // Extract number from cauldron ID (e.g., "cauldron_001" -> 1, "cauldron_012" -> 12)
    const getCauldronNumber = (cauldronId: string): number => {
      const parts = cauldronId.split('_')
      const lastPart = parts[parts.length - 1]
      // Try to extract number from last part (remove leading zeros)
      const numStr = lastPart?.replace(/^0+/, '') || lastPart || '0'
      const number = parseInt(numStr, 10) || 0
      // If parsing failed, try parsing the whole ID
      if (number === 0) {
        const extracted = parseInt(cauldronId.replace(/\D/g, ''), 10) || 0
        return extracted
      }
      return number
    }
    
    newForecasts.sort((a, b) => {
      const numA = getCauldronNumber(a.cauldronId)
      const numB = getCauldronNumber(b.cauldronId)
      return numA - numB
    })

    setForecasts(newForecasts)
  }, [historicalData, cauldrons])

  const refreshData = () => {
    if (dataStartTime && dataEndTime) {
      setLoading(true)
      apiService.getHistoricalData(dataStartTime, dataEndTime)
        .then(data => {
          setAllHistoricalData(data)
          setLoading(false)
        })
        .catch(err => {
          console.error('Failed to fetch historical data:', err)
          setLoading(false)
        })
    }
  }

  // Calculate available time range in days
  const availableTimeRange = useMemo(() => {
    if (allHistoricalData.length === 0) return { min: 0, max: 0 }
    const firstTimestamp = new Date(allHistoricalData[0].timestamp).getTime()
    const lastTimestamp = new Date(allHistoricalData[allHistoricalData.length - 1].timestamp).getTime()
    const totalDays = Math.ceil((lastTimestamp - firstTimestamp) / (24 * 60 * 60 * 1000))
    return { min: 1, max: Math.max(1, totalDays) }
  }, [allHistoricalData])

  // Format time range display
  const formatTimeRange = (days: number) => {
    if (days === availableTimeRange.max) return 'All Data'
    if (days === 1) return 'Last 1 Day'
    return `Last ${days} Days`
  }

  const formatTime = (minutes: number): string => {
    if (minutes === Infinity || minutes < 0) return 'N/A'
    const hours = Math.floor(minutes / 60)
    const mins = Math.floor(minutes % 60)
    if (hours > 0) {
      return `${hours}h ${mins}m`
    }
    return `${mins}m`
  }
  
  // Format simulation time for display
  const formatSimulationTime = () => {
    if (!simulationTime || !timeSpan) return 'N/A'
    const date = new Date(simulationTime)
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
  
  // Calculate simulation progress (0-100%)
  const simulationProgress = useMemo(() => {
    if (!timeSpan || simulationTime === null) return 0
    return ((simulationTime - timeSpan.start) / timeSpan.totalMs) * 100
  }, [timeSpan, simulationTime])
  
  // Convert simulation time to minutes for slider
  const simulationTimeMinutes = useMemo(() => {
    if (!timeSpan || simulationTime === null) return 0
    return Math.floor((simulationTime - timeSpan.start) / (1000 * 60))
  }, [timeSpan, simulationTime])
  
  // Handle slider change
  const handleSimulationTimeChange = (minutes: number) => {
    if (!timeSpan) return
    const newTime = timeSpan.start + (minutes * 60 * 1000)
    setSimulationTime(Math.min(newTime, timeSpan.end))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-purple-400 mx-auto mb-4" />
          <p className="text-muted-foreground">Loading forecasting data...</p>
        </div>
      </div>
    )
  }

  const highRiskCount = forecasts.filter(f => f.riskLevel === 'high').length
  const mediumRiskCount = forecasts.filter(f => f.riskLevel === 'medium').length
  const lowRiskCount = forecasts.filter(f => f.riskLevel === 'low').length

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-background/80 backdrop-blur-sm border-purple-500/30">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Overflow Prevention Forecast</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Predicting time until overflow for all cauldrons
            </p>
          </div>
          <Button
            onClick={refreshData}
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        {/* Simulation Timeline Controls */}
        {timeSpan && (
          <Card className="p-4 mb-6 border-purple-500/30 bg-purple-500/5">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-purple-400" />
                  <span className="text-sm font-semibold text-foreground">Simulation Timeline</span>
                </div>
                <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/30">
                  {formatSimulationTime()}
                </Badge>
              </div>
              
              {/* Timeline Slider */}
              <div className="space-y-2">
                <Slider
                  value={[simulationTimeMinutes]}
                  onValueChange={(values) => handleSimulationTimeChange(values[0] || 0)}
                  min={0}
                  max={timeSpan.totalMinutes}
                  step={1}
                  className="purple"
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {timeSpan.start ? new Date(timeSpan.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Start'}
                  </span>
                  <span className="font-medium text-purple-400">
                    {simulationProgress.toFixed(1)}%
                  </span>
                  <span>
                    {timeSpan.end ? new Date(timeSpan.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'End'}
                  </span>
                </div>
              </div>
              
              {/* Playback Controls */}
              <div className="flex items-center justify-between pt-2 border-t border-purple-500/20">
                <div className="flex items-center gap-3">
                  <Button
                    size="icon"
                    onClick={() => setIsPlaying(!isPlaying)}
                    className="h-10 w-10 rounded-full bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400"
                  >
                    {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                  </Button>
                  
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={playbackSpeed === 1 ? 'default' : 'outline'}
                      onClick={() => setPlaybackSpeed(1)}
                      className={`h-8 rounded-full ${
                        playbackSpeed === 1
                          ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400'
                          : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                      }`}
                    >
                      <span className="text-xs font-semibold">1x</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={playbackSpeed === 5 ? 'default' : 'outline'}
                      onClick={() => setPlaybackSpeed(5)}
                      className={`h-8 rounded-full ${
                        playbackSpeed === 5
                          ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400'
                          : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                      }`}
                    >
                      <span className="text-xs font-semibold">5x</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={playbackSpeed === 10 ? 'default' : 'outline'}
                      onClick={() => setPlaybackSpeed(10)}
                      className={`h-8 rounded-full ${
                        playbackSpeed === 10
                          ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400'
                          : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                      }`}
                    >
                      <span className="text-xs font-semibold">10x</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={playbackSpeed === 20 ? 'default' : 'outline'}
                      onClick={() => setPlaybackSpeed(20)}
                      className={`h-8 rounded-full ${
                        playbackSpeed === 20
                          ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400'
                          : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                      }`}
                    >
                      <span className="text-xs font-semibold">20x</span>
                    </Button>
                  </div>
                </div>
                
                <div className="text-xs text-muted-foreground">
                  {historicalData.length.toLocaleString()} data points up to current time
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Card className="p-4 border-red-500/30 bg-red-500/5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <span className="text-sm font-semibold text-red-500">High Risk</span>
            </div>
            <div className="text-2xl font-bold text-red-500">{highRiskCount}</div>
            <div className="text-xs text-muted-foreground">Overflow in &lt;4 hours</div>
          </Card>
          <Card className="p-4 border-yellow-500/30 bg-yellow-500/5">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="h-5 w-5 text-yellow-500" />
              <span className="text-sm font-semibold text-yellow-500">Medium Risk</span>
            </div>
            <div className="text-2xl font-bold text-yellow-500">{mediumRiskCount}</div>
            <div className="text-xs text-muted-foreground">Overflow in 4-8 hours</div>
          </Card>
          <Card className="p-4 border-green-500/30 bg-green-500/5">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-sm font-semibold text-green-500">Low Risk</span>
            </div>
            <div className="text-2xl font-bold text-green-500">{lowRiskCount}</div>
            <div className="text-xs text-muted-foreground">Overflow in &gt;8 hours</div>
          </Card>
        </div>

        {/* Forecasts Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left p-3 text-sm font-semibold text-foreground">Cauldron</th>
                <th className="text-left p-3 text-sm font-semibold text-foreground">Current Level</th>
                <th className="text-left p-3 text-sm font-semibold text-foreground">Fill Rate</th>
                <th className="text-left p-3 text-sm font-semibold text-foreground">Time Until Overflow</th>
                <th className="text-left p-3 text-sm font-semibold text-foreground">Overflow Time</th>
                <th className="text-left p-3 text-sm font-semibold text-foreground">Risk Level</th>
              </tr>
            </thead>
            <tbody>
              {forecasts.map((forecast) => {
                const percentage = (forecast.currentLevel / forecast.maxVolume) * 100
                const riskColors = {
                  high: 'bg-red-500/10 text-red-500 border-red-500/30',
                  medium: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
                  low: 'bg-green-500/10 text-green-500 border-green-500/30'
                }

                return (
                  <tr key={forecast.cauldronId} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="p-3">
                      <div className="font-medium text-foreground">{forecast.cauldronName}</div>
                      <div className="text-xs text-muted-foreground">{forecast.cauldronId}</div>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-muted rounded-full h-2">
                          <div
                            className="h-2 rounded-full transition-all"
                            style={{
                              width: `${Math.min(percentage, 100)}%`,
                              backgroundColor: forecast.riskLevel === 'high' ? '#ef4444' : 
                                             forecast.riskLevel === 'medium' ? '#f59e0b' : '#10b981'
                            }}
                          />
                        </div>
                        <span className="text-sm font-medium text-foreground">
                          {forecast.currentLevel.toFixed(2)}L / {forecast.maxVolume.toFixed(2)}L
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {percentage.toFixed(1)}% full
                      </div>
                    </td>
                    <td className="p-3">
                      <span className="text-sm text-foreground">
                        {forecast.fillRate.toFixed(4)} L/min
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="text-sm font-medium text-foreground">
                        {formatTime(forecast.timeUntilOverflow)}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="text-sm text-foreground">
                        {forecast.overflowTimestamp.toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                    </td>
                    <td className="p-3">
                      <Badge className={riskColors[forecast.riskLevel]}>
                        {forecast.riskLevel.toUpperCase()}
                      </Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

      </Card>
    </div>
  )
}

