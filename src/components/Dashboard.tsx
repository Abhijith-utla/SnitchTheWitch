import { useState, useEffect } from 'react'
import { Card } from './ui/card'
import { Slider } from './ui/slider'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Play, Pause } from 'lucide-react'
import NetworkMap from './NetworkMap'
import StatsPanel from './StatsPanel'
import AuditLog from './AuditLog'
import { apiService } from '../services/api'
import { runAudit } from '../utils/audit'
import { monitorRealTime, initializeMonitoringState, type Alert, type MonitoringState } from '../utils/realtimeMonitoring'
import type {
  CauldronDto,
  CourierDto,
  NetworkDto,
  TicketsDto,
  HistoricalDataDto,
  MarketDto,
} from '../types/api'
import type { Discrepancy, DrainEvent } from '../utils/audit'

const MINUTES_PER_DAY = 1440
// Data range: Oct 30 to Nov 11 = 13 days
const ACTUAL_DAYS = 13
const TOTAL_MINUTES = MINUTES_PER_DAY * ACTUAL_DAYS

// Date range for API: Oct 30 to Nov 11
// Assuming year 2024 (or current year)
const getDateRange = () => {
  const year = new Date().getFullYear()
  const startDate = new Date(year, 9, 30, 0, 0, 0) // Oct 30 (month is 0-indexed)
  const endDate = new Date(year, 10, 11, 23, 59, 59) // Nov 11
  return {
    startTimestamp: Math.floor(startDate.getTime() / 1000), // Convert to seconds (Unix timestamp)
    endTimestamp: Math.floor(endDate.getTime() / 1000),
    startDate,
    endDate,
  }
}

interface DashboardProps {
  onDataLoad?: (data: {
    cauldrons: CauldronDto[]
    historicalData: HistoricalDataDto[]
    tickets: TicketsDto | null
    network: NetworkDto | null
    couriers: CourierDto[]
    market: MarketDto | null
    dataStartTime: number
    dataEndTime: number
  }) => void
  showMap?: boolean
}

export default function PotionNetworkDashboard({ onDataLoad, showMap = true }: DashboardProps) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [selectedCauldron, setSelectedCauldron] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<number>(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
      const [playbackSpeed, setPlaybackSpeed] = useState(1) // 1x, 5x, 10x

  // API Data
  const [network, setNetwork] = useState<NetworkDto | null>(null)
  const [cauldrons, setCauldrons] = useState<CauldronDto[]>([])
  const [couriers, setCouriers] = useState<CourierDto[]>([])
  const [tickets, setTickets] = useState<TicketsDto | null>(null)
  const [historicalData, setHistoricalData] = useState<HistoricalDataDto[]>([])
  const [market, setMarket] = useState<MarketDto | null>(null)
  const [dataStartTime, setDataStartTime] = useState<number>(0)
  const [dataEndTime, setDataEndTime] = useState<number>(0)
  const [dataTimeSpan, setDataTimeSpan] = useState<number>(TOTAL_MINUTES)
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[]>([])
  const [drainEvents, setDrainEvents] = useState<DrainEvent[]>([])
  const [realtimeAlerts, setRealtimeAlerts] = useState<Alert[]>([])
  const [monitoringState, setMonitoringState] = useState<MonitoringState>(initializeMonitoringState())

  useEffect(() => {
    loadAllData()
  }, [])

  const loadAllData = async () => {
    try {
      setLoading(true)
      setError(null)
      
      // Get date range for Oct 30 to Nov 11
      const dateRange = getDateRange()
      
      const [networkData, cauldronsData, couriersData, ticketsData, historicalDataData, marketData] = await Promise.all([
        apiService.getNetwork(),
        apiService.getCauldrons(),
        apiService.getCouriers(),
        apiService.getTickets(),
        apiService.getHistoricalData(dateRange.startTimestamp, dateRange.endTimestamp),
        apiService.getMarket(),
      ])

      setNetwork(networkData)
      setCauldrons(cauldronsData)
      setCouriers(couriersData)
      setTickets(ticketsData)
      setHistoricalData(historicalDataData)
      setMarket(marketData)

      // Notify parent component of loaded data
      if (onDataLoad) {
        const dateRange = getDateRange()
        onDataLoad({
          cauldrons: cauldronsData,
          historicalData: historicalDataData,
          tickets: ticketsData,
          network: networkData,
          couriers: couriersData,
          market: marketData,
          dataStartTime: historicalDataData.length > 0 
            ? new Date(historicalDataData[0].timestamp).getTime()
            : dateRange.startDate.getTime(),
          dataEndTime: historicalDataData.length > 0
            ? new Date(historicalDataData[historicalDataData.length - 1].timestamp).getTime()
            : dateRange.endDate.getTime(),
        })
      }

      // Calculate actual time span from historical data timestamps
      if (historicalDataData.length > 0) {
        const firstTimestamp = new Date(historicalDataData[0].timestamp).getTime()
        const lastTimestamp = new Date(historicalDataData[historicalDataData.length - 1].timestamp).getTime()
        const spanMs = lastTimestamp - firstTimestamp
        const spanMinutes = Math.floor(spanMs / (1000 * 60))
        
        setDataStartTime(firstTimestamp)
        setDataEndTime(lastTimestamp)
        setDataTimeSpan(Math.max(spanMinutes, TOTAL_MINUTES)) // Use actual span or minimum of 13 days
      } else {
        // Fallback to date range if no data
        const dateRange = getDateRange()
        setDataStartTime(dateRange.startDate.getTime())
        setDataEndTime(dateRange.endDate.getTime())
        setDataTimeSpan(TOTAL_MINUTES)
      }

      // Run audit system to detect discrepancies
      if (cauldronsData.length > 0 && historicalDataData.length > 0 && ticketsData?.transport_tickets) {
        const auditResult = runAudit(
          cauldronsData,
          historicalDataData,
          ticketsData.transport_tickets
        )
        setDrainEvents(auditResult.drainEvents)
        setDiscrepancies(auditResult.discrepancies)
      }
      
      // Initialize monitoring state
      setMonitoringState(initializeMonitoringState())
    } catch (err: any) {
      setError(err?.message || 'Failed to load data')
      console.error('Error loading data:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isPlaying) {
      // Adjust interval based on playback speed (faster speed = shorter interval)
      const baseInterval = 100 // 100ms base interval
      const interval = baseInterval / playbackSpeed
      
      const timer = setInterval(() => {
        setCurrentTime((prev) => {
          const next = prev + playbackSpeed // Advance by speed multiplier
          if (next >= TOTAL_MINUTES) {
            setIsPlaying(false)
            return TOTAL_MINUTES - 1
          }
          return next
        })
      }, interval)
      return () => clearInterval(timer)
    }
  }, [isPlaying, playbackSpeed])

  // Update selected day when currentTime changes
  useEffect(() => {
    const day = Math.floor(currentTime / MINUTES_PER_DAY) + 1
    setSelectedDay(Math.min(day, ACTUAL_DAYS))
  }, [currentTime])

  // Real-time monitoring - runs on current time change
  useEffect(() => {
    if (historicalData.length === 0 || cauldrons.length === 0) return
    
        const currentTimestamp = getCurrentTimestamp()
        if (!currentTimestamp) return
        const { alerts: newAlerts, updatedState } = monitorRealTime(
          cauldrons,
          historicalData,
          tickets?.transport_tickets || [],
          currentTimestamp,
          monitoringState,
          couriers,
          network
        )
    
    if (newAlerts.length > 0) {
      setRealtimeAlerts(prev => {
        // Keep only recent alerts (last 50)
        const combined = [...prev, ...newAlerts]
        return combined.slice(-50).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      })
      
      // Removed popup logic - warnings now shown as icons on map and in node details
    }
    
    // Update monitoring state
    setMonitoringState(updatedState)
  }, [currentTime, historicalData, cauldrons, tickets, monitoringState, isPlaying])

  const formatTime = (minutes: number) => {
    const totalDays = Math.floor(minutes / MINUTES_PER_DAY)
    const dayOfWeek = totalDays + 1
    const minutesInDay = minutes % MINUTES_PER_DAY
    const hours = Math.floor(minutesInDay / 60)
    const mins = minutesInDay % 60
    
    // Get actual date from historical data if available
    if (historicalData.length > 0 && dataStartTime > 0) {
      const progress = minutes / TOTAL_MINUTES
      const targetTimestamp = dataStartTime + (progress * (dataEndTime - dataStartTime))
      const date = new Date(targetTimestamp)
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return `${dateStr}, ${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
    }
    
    return `Day ${dayOfWeek}, ${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
  }

  // Get date for a specific day
  const getDateForDay = (day: number) => {
    if (historicalData.length === 0 || dataStartTime === 0) {
      // Fallback: calculate from Oct 30
      const dateRange = getDateRange()
      const dayIndex = day - 1
      const dayDate = new Date(dateRange.startDate)
      dayDate.setDate(dayDate.getDate() + dayIndex)
      return dayDate
    }
    const dayIndex = day - 1
    const dayStartMinutes = dayIndex * MINUTES_PER_DAY
    const progress = dayStartMinutes / TOTAL_MINUTES
    const targetTimestamp = dataStartTime + (progress * (dataEndTime - dataStartTime))
    return new Date(targetTimestamp)
  }

  const jumpToDay = (day: number) => {
    const dayIndex = day - 1
    const newTime = dayIndex * MINUTES_PER_DAY
    setCurrentTime(newTime)
    setSelectedDay(day)
  }


  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center">
          <p className="text-destructive mb-4">Error: {error}</p>
          <Button onClick={loadAllData}>Retry</Button>
        </div>
      </div>
    )
  }

  // If showMap is false, don't render the map view (used when loading data for Graphs tab)
  if (!showMap) {
    return null
  }

  // Get current cauldron levels from historical data based on actual timestamps
  const getCurrentCauldronLevels = () => {
    if (historicalData.length === 0 || dataTimeSpan === 0) return {}
    
    // Calculate the actual timestamp for currentTime
    const progress = currentTime / TOTAL_MINUTES // 0 to 1
    const targetTimestamp = dataStartTime + (progress * (dataEndTime - dataStartTime))
    
    // Find the closest data point by timestamp
    let closestIndex = 0
    let minDiff = Math.abs(new Date(historicalData[0].timestamp).getTime() - targetTimestamp)
    
    for (let i = 1; i < historicalData.length; i++) {
      const diff = Math.abs(new Date(historicalData[i].timestamp).getTime() - targetTimestamp)
      if (diff < minDiff) {
        minDiff = diff
        closestIndex = i
      }
    }
    
    return historicalData[closestIndex]?.cauldron_levels || {}
  }

  // Get current timestamp for filtering tickets
  const getCurrentTimestamp = () => {
    if (dataTimeSpan === 0) return null
    const progress = currentTime / TOTAL_MINUTES
    const targetTimestamp = dataStartTime + (progress * (dataEndTime - dataStartTime))
    return new Date(targetTimestamp)
  }

  // Get active alerts - only show critical and most urgent warnings, sorted by date
  const activeAlerts = realtimeAlerts
    .filter(alert => {
      // Only show critical alerts and urgent warnings (overflow, drift, discrepancy)
      if (alert.severity === 'critical') return true
      if (alert.severity === 'warning' && (alert.type === 'overflow' || alert.type === 'drift' || alert.type === 'discrepancy')) {
        return true
      }
      return false
    })
    .filter(alert => {
      // Show alerts from last 10 minutes of simulation time
      const alertTime = alert.timestamp.getTime()
      const currentTimestamp = getCurrentTimestamp()
      if (!currentTimestamp) return false
      const currentTimeMs = currentTimestamp.getTime()
      return Math.abs(currentTimeMs - alertTime) < 10 * 60 * 1000
    })
    .sort((a, b) => {
      // Sort by timestamp (chronological order as simulation runs)
      return a.timestamp.getTime() - b.timestamp.getTime()
    })
    .slice(-10) // Show last 10 alerts

  return (
    <div className="space-y-6">
      {/* Subheading */}
      <p className="text-muted-foreground">Real-time network visualization & discrepancy detection system</p>

      {/* Main Content */}
        <div className="space-y-6">
          {/* Network Map with Side Panel */}
          <div className="flex items-start gap-6">
            {/* Map Card - Takes remaining space */}
            <Card className="p-6 border-border bg-card relative flex-1">
              <div className="space-y-4">
              <div className="flex items-start gap-4">
                  {/* Network Map - Spans full width until controls */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-xl font-semibold">
                        Enchanted Cauldron Network
                      </h2>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-green-500 border-green-500/30 bg-green-500/10">
                          ● Safe
                        </Badge>
                        <Badge variant="outline" className="text-yellow-500 border-yellow-500/30 bg-yellow-500/10">
                          ● Elevated
                        </Badge>
                        <Badge variant="outline" className="text-red-500 border-red-500/30 bg-red-500/10">
                          ● Critical
                        </Badge>
                      </div>
                    </div>
                    <NetworkMap
                      currentTime={currentTime}
                      onCauldronSelect={setSelectedCauldron}
                      selectedCauldron={selectedCauldron}
                      cauldrons={cauldrons}
                      network={network}
                      couriers={couriers}
                      currentLevels={getCurrentCauldronLevels()}
                      tickets={tickets?.transport_tickets || []}
                      currentTimestamp={getCurrentTimestamp()}
                      market={market}
                      alerts={activeAlerts}
                      discrepancies={discrepancies}
                    />
                  </div>

                  {/* Timeline Controls - Inside Map Card */}
                  <div className="flex items-start gap-3">
                    {/* Timeline Container - matches map card height */}
                    <div className="relative flex items-center" style={{ height: '600px', width: '120px' }}>
                      {/* Vertical Slider */}
                      <div className="relative" style={{ height: '600px', width: '20px' }}>
                        <Slider
                          value={[currentTime]}
                          onValueChange={(values: number[]) => setCurrentTime(values[0] || 0)}
                          max={TOTAL_MINUTES - 1}
                          step={1}
                          orientation="vertical"
                          className="h-full purple"
                        />
                      </div>
                      
                      {/* Date markers and labels positioned along the slider */}
                      <div className="absolute left-6 inset-y-0 flex flex-col justify-between" style={{ width: '100px' }}>
                        {Array.from({ length: ACTUAL_DAYS }, (_, i) => {
                          const day = i + 1
                          const dayDate = getDateForDay(day)
                          const dateLabel = dayDate 
                            ? dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            : `Day ${day}`
                          
                          // Calculate position: day 1 at bottom (100%), day 13 at top (0%)
                          const positionPercent = ((ACTUAL_DAYS - day) / (ACTUAL_DAYS - 1)) * 100
                          const isSelected = selectedDay === day
                          
                          return (
                            <div
                              key={day}
                              className="absolute left-0 flex items-center gap-2"
                              style={{
                                top: `${positionPercent}%`,
                                transform: 'translateY(-50%)'
                              }}
                            >
                              {/* Date marker dot */}
                              <div className={`w-2 h-2 rounded-full border-2 transition-all flex-shrink-0 ${
                                isSelected 
                                  ? 'bg-purple-400 border-purple-400 scale-125' 
                                  : 'bg-purple-500/30 border-purple-500/50 hover:border-purple-400'
                              }`} />
                              
                              {/* Date label button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  jumpToDay(day)
                                }}
                                className={`text-[10px] px-2 py-1 rounded transition-all whitespace-nowrap ${
                                  isSelected 
                                    ? 'bg-purple-500 text-white font-semibold' 
                                    : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300'
                                }`}
                                title={dateLabel}
                              >
                                {dateLabel}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    
                    {/* Play and Speed Controls - Circular buttons in center */}
                    <div className="flex flex-col items-center justify-center gap-3" style={{ height: '600px', width: '60px' }}>
                      {/* Play/Pause Button */}
                      <Button 
                        size="icon" 
                        onClick={() => setIsPlaying(!isPlaying)} 
                        className="h-12 w-12 rounded-full bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400"
                      >
                        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                      </Button>
                      
                      {/* Speed Buttons */}
                      <div className="flex flex-col gap-2">
                        <Button
                          size="icon"
                          variant={playbackSpeed === 1 ? 'default' : 'outline'}
                          onClick={() => setPlaybackSpeed(1)}
                          className={`h-10 w-10 rounded-full ${
                            playbackSpeed === 1 
                              ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400' 
                              : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                          }`}
                        >
                          <span className="text-xs font-semibold">1x</span>
                        </Button>
                        <Button
                          size="icon"
                          variant={playbackSpeed === 5 ? 'default' : 'outline'}
                          onClick={() => setPlaybackSpeed(5)}
                          className={`h-10 w-10 rounded-full ${
                            playbackSpeed === 5 
                              ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400' 
                              : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                          }`}
                        >
                          <span className="text-xs font-semibold">5x</span>
                        </Button>
                        <Button
                          size="icon"
                          variant={playbackSpeed === 10 ? 'default' : 'outline'}
                          onClick={() => setPlaybackSpeed(10)}
                          className={`h-10 w-10 rounded-full ${
                            playbackSpeed === 10 
                              ? 'bg-purple-500 hover:bg-purple-600 text-white border-2 border-purple-400' 
                              : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-2 border-purple-500/50'
                          }`}
                        >
                          <span className="text-xs font-semibold">10x</span>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Current Time Display */}
                <div className="text-center">
                  <div className="text-xs font-medium mb-1 text-purple-300">{formatTime(currentTime)}</div>
                  <div className="text-[10px] text-purple-400/70">
                    Day {selectedDay} of {ACTUAL_DAYS}
                  </div>
                </div>
              </div>
            </Card>

            {/* Cauldron Details Panel - Right Side */}
            {selectedCauldron !== null && (
              <div className="w-[400px] flex-shrink-0">
                <StatsPanel
                  selectedCauldron={selectedCauldron}
                  currentTime={currentTime}
                  cauldrons={cauldrons}
                  currentLevels={getCurrentCauldronLevels()}
                  alerts={activeAlerts}
                />
              </div>
            )}
          </div>

          {/* Audit Report */}
          <AuditLog 
            discrepancies={discrepancies}
            drainEvents={drainEvents}
            tickets={tickets?.transport_tickets || []}
            cauldrons={cauldrons}
            couriers={couriers}
            currentTimestamp={getCurrentTimestamp()}
          />
        </div>
    </div>
  )
}

