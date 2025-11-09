import { useState, useMemo, useEffect } from 'react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts'
import { ChevronLeft, ChevronRight, Droplets } from 'lucide-react'
import type { CauldronDto, HistoricalDataDto, TicketDto } from '../types/api'

interface GraphsTabProps {
  cauldrons: CauldronDto[]
  historicalData: HistoricalDataDto[]
  tickets: TicketDto[]
  dataStartTime: number
  dataEndTime: number
}

export default function GraphsTab({ cauldrons, historicalData, tickets, dataStartTime, dataEndTime }: GraphsTabProps) {
  const [selectedCauldron, setSelectedCauldron] = useState<string | null>(null)
  const [hoveredTicket, setHoveredTicket] = useState<{ ticketId: string; amount: number; timestamp: number } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true)
  const [hoverTimeout, setHoverTimeout] = useState<NodeJS.Timeout | null>(null)
  const [rightHoverTimeout, setRightHoverTimeout] = useState<NodeJS.Timeout | null>(null)
  const [visibleDataPoints, setVisibleDataPoints] = useState<number>(0)
  const [isAnimating, setIsAnimating] = useState(false)

  // Auto-toggle sidebar when mouse is near left edge
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const edgeThreshold = 50 // pixels from left edge
      
      if (e.clientX < edgeThreshold) {
        // Mouse is near left edge, show sidebar
        if (hoverTimeout) {
          clearTimeout(hoverTimeout)
          setHoverTimeout(null)
        }
        setSidebarOpen(true)
      } else if (!sidebarOpen && e.clientX > edgeThreshold + 200) {
        // Mouse moved away from edge and sidebar area, hide sidebar after delay
        const timeout = setTimeout(() => {
          setSidebarOpen(false)
        }, 500) // 500ms delay before hiding
        setHoverTimeout(timeout)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (hoverTimeout) {
        clearTimeout(hoverTimeout)
      }
    }
  }, [sidebarOpen, hoverTimeout])

  // Auto-toggle right sidebar when mouse is near right edge
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const edgeThreshold = 50 // pixels from right edge
      const windowWidth = window.innerWidth
      
      if (e.clientX > windowWidth - edgeThreshold) {
        // Mouse is near right edge, show sidebar
        if (rightHoverTimeout) {
          clearTimeout(rightHoverTimeout)
          setRightHoverTimeout(null)
        }
        setRightSidebarOpen(true)
      } else if (!rightSidebarOpen && e.clientX < windowWidth - edgeThreshold - 200) {
        // Mouse moved away from edge and sidebar area, hide sidebar after delay
        const timeout = setTimeout(() => {
          setRightSidebarOpen(false)
        }, 500) // 500ms delay before hiding
        setRightHoverTimeout(timeout)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (rightHoverTimeout) {
        clearTimeout(rightHoverTimeout)
      }
    }
  }, [rightSidebarOpen, rightHoverTimeout])

  // Color palette for different cauldrons
  const cauldronColors = [
    '#3b82f6', // blue
    '#10b981', // green
    '#f59e0b', // amber
    '#ef4444', // red
    '#8b5cf6', // purple
    '#06b6d4', // cyan
    '#ec4899', // pink
    '#84cc16', // lime
    '#f97316', // orange
    '#6366f1', // indigo
    '#14b8a6', // teal
    '#a855f7', // violet
  ]

  // Get color for a cauldron by its index
  const getCauldronColor = (index: number) => {
    return cauldronColors[index % cauldronColors.length]
  }

  // Update selected cauldron when cauldrons are available
  useEffect(() => {
    if (cauldrons.length > 0 && !selectedCauldron) {
      setSelectedCauldron(cauldrons[0]?.id || null)
    }
  }, [cauldrons, selectedCauldron])

  // Show loading state if no data
  if (cauldrons.length === 0 || historicalData.length === 0) {
    return (
      <div className="flex items-center justify-center h-[600px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading graph data...</p>
        </div>
      </div>
    )
  }

  // Prepare chart data for selected cauldron
  const chartData = useMemo(() => {
    if (!selectedCauldron || !historicalData || historicalData.length === 0 || !cauldrons || cauldrons.length === 0) {
      return { data: [], fillRate: 0, dropPeriods: [], ticketsByDropPeriod: new Map(), unmatchedTickets: [] }
    }

    const cauldronKey = `cauldron_${selectedCauldron.split('_').pop()?.padStart(3, '0') || '001'}`
    const selectedCauldronData = cauldrons.find(c => c.id === selectedCauldron)
    if (!selectedCauldronData) {
      return { data: [], fillRate: 0, dropPeriods: [], ticketsByDropPeriod: new Map(), unmatchedTickets: [] }
    }

    // Get tickets for this cauldron, sorted by date
    const cauldronTickets = (tickets || [])
      .filter(t => t && t.cauldron_id === selectedCauldron && t.date && t.amount_collected)
      .sort((a, b) => {
        const dateA = new Date(a.date!).getTime()
        const dateB = new Date(b.date!).getTime()
        return dateA - dateB
      })

    // Step 1: Calculate fill rate from ALL upward segments in actual data
    // This is the rate at which the cauldron fills when not being drained
    const fillRates: number[] = []
    
    for (let i = 1; i < historicalData.length; i++) {
      const prevPoint = historicalData[i - 1]
      const currPoint = historicalData[i]
      if (!prevPoint || !currPoint || !prevPoint.timestamp || !currPoint.timestamp) continue
      
      const prevLevel = (prevPoint.cauldron_levels as any)?.[cauldronKey] || 0
      const currLevel = (currPoint.cauldron_levels as any)?.[cauldronKey] || 0
      const prevTime = new Date(prevPoint.timestamp).getTime()
      const currTime = new Date(currPoint.timestamp).getTime()
      if (isNaN(prevTime) || isNaN(currTime)) continue
      
      const timeDiff = (currTime - prevTime) / (1000 * 60) // minutes
      
      // If level increased (filling), calculate the rate
      if (currLevel > prevLevel && timeDiff > 0) {
        const rate = (currLevel - prevLevel) / timeDiff
        if (rate > 0) {
          fillRates.push(rate)
        }
      }
    }
    
    // Calculate median fill rate (more robust than mean)
    let avgFillRate = 0.01 // Default
    if (fillRates.length > 0) {
      fillRates.sort((a, b) => a - b)
      const medianIndex = Math.floor(fillRates.length / 2)
      avgFillRate = fillRates.length % 2 === 0
        ? (fillRates[medianIndex - 1] + fillRates[medianIndex]) / 2
        : fillRates[medianIndex]
      avgFillRate = Math.max(0, avgFillRate)
    }
    
    // Step 2: Detect drop periods in actual data (where level is decreasing)
    // A drop period starts when level begins decreasing and ends when it starts increasing again
    const dropPeriods: Array<{ 
      startIndex: number
      endIndex: number
      startTime: number
      endTime: number
      startLevel: number
      endLevel: number
      dropAmount: number
    }> = []
    
    let dropStart: { index: number; timestamp: number; level: number } | null = null
    
    for (let i = 1; i < historicalData.length; i++) {
      const prevPoint = historicalData[i - 1]
      const currPoint = historicalData[i]
      if (!prevPoint || !currPoint || !prevPoint.timestamp || !currPoint.timestamp) continue
      
      const prevLevel = (prevPoint.cauldron_levels as any)?.[cauldronKey] || 0
      const currLevel = (currPoint.cauldron_levels as any)?.[cauldronKey] || 0
      const prevTime = new Date(prevPoint.timestamp).getTime()
      const currTime = new Date(currPoint.timestamp).getTime()
      if (isNaN(prevTime) || isNaN(currTime)) continue
      
      const timeDiff = (currTime - prevTime) / (1000 * 60) // minutes
      const expectedFill = avgFillRate * timeDiff
      const actualChange = prevLevel - currLevel
      const dropAmount = actualChange - expectedFill
      
      // Detect when drop starts (level decreasing significantly)
      if (dropAmount > 0.1 && !dropStart) {
        dropStart = {
          index: i - 1,
          timestamp: prevTime,
          level: prevLevel,
        }
      }
      
      // Detect when drop ends (level starts increasing or stabilizes)
      if (dropStart && (currLevel >= prevLevel || dropAmount <= 0.1)) {
        dropPeriods.push({
          startIndex: dropStart.index,
          endIndex: i - 1,
          startTime: dropStart.timestamp,
          endTime: prevTime,
          startLevel: dropStart.level,
          endLevel: prevLevel,
          dropAmount: dropStart.level - prevLevel,
        })
        dropStart = null
      }
    }
    
    // Handle case where drop continues to end of data
    if (dropStart) {
      const lastPoint = historicalData[historicalData.length - 1]
      if (lastPoint && lastPoint.timestamp) {
        const lastTime = new Date(lastPoint.timestamp).getTime()
        const lastLevel = (lastPoint.cauldron_levels as any)?.[cauldronKey] || 0
        dropPeriods.push({
          startIndex: dropStart.index,
          endIndex: historicalData.length - 1,
          startTime: dropStart.timestamp,
          endTime: lastTime,
          startLevel: dropStart.level,
          endLevel: lastLevel,
          dropAmount: dropStart.level - lastLevel,
        })
      }
    }
    
    // Step 3: Match tickets to drop periods first (to know how many tickets we have)
    const ticketsByDropPeriod = new Map<number, { amount: number; ticketId: string }>()
    let ticketIndex = 0
    for (let dropIndex = 0; dropIndex < dropPeriods.length && ticketIndex < cauldronTickets.length; dropIndex++) {
      const dropPeriod = dropPeriods[dropIndex]
      const ticket = cauldronTickets[ticketIndex]
      
      if (ticket && ticket.amount_collected && ticket.ticket_id) {
        ticketsByDropPeriod.set(dropPeriod.startIndex, {
          amount: ticket.amount_collected,
          ticketId: ticket.ticket_id
        })
        ticketIndex++
      }
    }
    
    // Filter out short drops (likely data faults or false drops)
    // Only filter if we have more drops than matched tickets
    let validDropPeriods = dropPeriods
    
    if (dropPeriods.length > ticketsByDropPeriod.size && dropPeriods.length > 1) {
      // Calculate duration for each drop period
      const dropDurations = dropPeriods.map(drop => drop.endTime - drop.startTime)
      dropDurations.sort((a, b) => a - b)
      
      // Calculate median duration (more robust than mean)
      const medianIndex = Math.floor(dropDurations.length / 2)
      const medianDuration = dropDurations.length % 2 === 0
        ? (dropDurations[medianIndex - 1] + dropDurations[medianIndex]) / 2
        : dropDurations[medianIndex]
      
      // Filter out drops that are less than 20% of the median duration
      // This removes very short drops that are likely data faults
      // But ensure we don't filter out everything by having a minimum threshold
      const minDuration = Math.max(medianDuration * 0.2, 5 * 60 * 1000) // At least 5 minutes
      
      validDropPeriods = dropPeriods.filter(drop => {
        const duration = drop.endTime - drop.startTime
        return duration >= minDuration
      })
      
      // Re-match tickets to filtered drops
      ticketsByDropPeriod.clear()
      ticketIndex = 0
      for (let dropIndex = 0; dropIndex < validDropPeriods.length && ticketIndex < cauldronTickets.length; dropIndex++) {
        const dropPeriod = validDropPeriods[dropIndex]
        const ticket = cauldronTickets[ticketIndex]
        
        if (ticket && ticket.amount_collected && ticket.ticket_id) {
          ticketsByDropPeriod.set(dropPeriod.startIndex, {
            amount: ticket.amount_collected,
            ticketId: ticket.ticket_id
          })
          ticketIndex++
        }
      }
      
      // If filtering removed all drops, use original drops (don't filter)
      if (validDropPeriods.length === 0) {
        validDropPeriods = dropPeriods
        // Re-match tickets to original drops
        ticketsByDropPeriod.clear()
        ticketIndex = 0
        for (let dropIndex = 0; dropIndex < dropPeriods.length && ticketIndex < cauldronTickets.length; dropIndex++) {
          const dropPeriod = dropPeriods[dropIndex]
          const ticket = cauldronTickets[ticketIndex]
          
          if (ticket && ticket.amount_collected && ticket.ticket_id) {
            ticketsByDropPeriod.set(dropPeriod.startIndex, {
              amount: ticket.amount_collected,
              ticketId: ticket.ticket_id
            })
            ticketIndex++
          }
        }
      }
    } else {
      // If drops <= tickets, match tickets to all drops
      ticketsByDropPeriod.clear()
      ticketIndex = 0
      for (let dropIndex = 0; dropIndex < dropPeriods.length && ticketIndex < cauldronTickets.length; dropIndex++) {
        const dropPeriod = dropPeriods[dropIndex]
        const ticket = cauldronTickets[ticketIndex]
        
        if (ticket && ticket.amount_collected && ticket.ticket_id) {
          ticketsByDropPeriod.set(dropPeriod.startIndex, {
            amount: ticket.amount_collected,
            ticketId: ticket.ticket_id
          })
          ticketIndex++
        }
      }
    }
    
    


    // Step 4: Build chart data (only actual, no predicted line)
    const data: Array<{
      time: string
      timestamp: number
      date: string
      actual: number
      maxVolume: number
    }> = []
    
    historicalData.forEach((point) => {
      if (!point || !point.timestamp) return
      const timestamp = new Date(point.timestamp)
      const timestampMs = timestamp.getTime()
      if (isNaN(timestampMs)) return
      const dateKey = timestamp.toISOString().split('T')[0]
      const actualLevel = (point.cauldron_levels as any)?.[cauldronKey] || 0
      
      data.push({
        time: timestamp.toISOString(),
        timestamp: timestampMs,
        date: dateKey,
        actual: Number(actualLevel.toFixed(2)),
        maxVolume: selectedCauldronData.max_volume,
      })
    })

    // Create a set of ticket IDs that are already matched to drop periods
    const matchedTicketIds = new Set<string>()
    ticketsByDropPeriod.forEach((ticketInfo) => {
      if (ticketInfo.ticketId) {
        matchedTicketIds.add(ticketInfo.ticketId)
      }
    })

    // Create a list of UNMATCHED tickets with their timestamps for plotting
    // Only show tickets that are NOT already matched to a drop period
    const unmatchedTickets = cauldronTickets
      .filter(t => t.date && t.amount_collected && t.ticket_id && !matchedTicketIds.has(t.ticket_id))
      .map(ticket => {
        const ticketTime = new Date(ticket.date!).getTime()
        // Find the closest historical data point to this ticket
        let closestDataPoint: { timestamp: number; level: number } | null = null
        let minTimeDiff = Infinity
        
        for (const point of historicalData) {
          if (!point.timestamp) continue
          const dataTime = new Date(point.timestamp).getTime()
          if (isNaN(dataTime)) continue
          
          const timeDiff = Math.abs(dataTime - ticketTime)
          if (timeDiff < minTimeDiff) {
            minTimeDiff = timeDiff
            const level = (point.cauldron_levels as any)?.[cauldronKey] || 0
            closestDataPoint = { timestamp: dataTime, level }
          }
        }
        
        return {
          ticketId: ticket.ticket_id!,
          amount: ticket.amount_collected!,
          timestamp: closestDataPoint?.timestamp || ticketTime,
          level: closestDataPoint?.level || 0,
        }
      })
      .filter(t => !isNaN(t.timestamp))

    return { data, fillRate: avgFillRate, dropPeriods: validDropPeriods, ticketsByDropPeriod, unmatchedTickets }
  }, [selectedCauldron, historicalData, tickets, cauldrons])

  // Slow-motion plotting animation effect (after chartData is computed)
  useEffect(() => {
    if (!selectedCauldron || !chartData.data || chartData.data.length === 0) {
      setVisibleDataPoints(0)
      setIsAnimating(false)
      return
    }

    // Reset and start animation when cauldron or data changes
    setVisibleDataPoints(0)
    setIsAnimating(true)

    const totalPoints = chartData.data.length
    const pointsPerFrame = Math.max(1, Math.floor(totalPoints / 200)) // Show ~200 frames for smooth animation
    const delayPerFrame = 20 // 20ms per frame = ~4 seconds for full animation

    let currentPoints = 0
    const interval = setInterval(() => {
      currentPoints += pointsPerFrame
      if (currentPoints >= totalPoints) {
        setVisibleDataPoints(totalPoints)
        setIsAnimating(false)
        clearInterval(interval)
      } else {
        setVisibleDataPoints(currentPoints)
      }
    }, delayPerFrame)

    return () => {
      clearInterval(interval)
    }
  }, [selectedCauldron, chartData])

  // Calculate ticket data with classifications for the right sidebar
  const ticketData = useMemo(() => {
    if (!selectedCauldron || !chartData) {
      return []
    }

    const cauldronTickets = (tickets || [])
      .filter(t => t && t.cauldron_id === selectedCauldron && t.date && t.amount_collected)
      .sort((a, b) => {
        const dateA = new Date(a.date!).getTime()
        const dateB = new Date(b.date!).getTime()
        return dateA - dateB
      })

    return cauldronTickets.map(ticket => {
      // Find matching drop period for this ticket
      let matchedDropPeriod: typeof chartData.dropPeriods[0] | null = null
      let ticketInfo: { amount: number; ticketId: string } | null = null

      if (chartData.dropPeriods && chartData.dropPeriods.length > 0) {
        for (const dropPeriod of chartData.dropPeriods) {
          const info = chartData.ticketsByDropPeriod?.get(dropPeriod.startIndex)
          if (info && info.ticketId === ticket.ticket_id) {
            matchedDropPeriod = dropPeriod
            ticketInfo = info
            break
          }
        }
      }

      let classification: 'Normal' | 'Discrepancy' = 'Normal'
      let actualDrop = 0
      let discrepancy = 0
      let discrepancyPercent = 0

      if (matchedDropPeriod && ticketInfo) {
        const timeDiff = (matchedDropPeriod.endTime - matchedDropPeriod.startTime) / (1000 * 60) // minutes
        const fillDuringDrop = chartData.fillRate * timeDiff
        actualDrop = matchedDropPeriod.dropAmount + fillDuringDrop
        discrepancy = Math.abs(actualDrop - ticketInfo.amount)
        const maxAmount = Math.max(actualDrop, ticketInfo.amount)
        discrepancyPercent = maxAmount > 0 ? (discrepancy / maxAmount) * 100 : 0

        // Classification: Normal if < 20%, Discrepancy if >= 20%
        if (discrepancyPercent >= 20) {
          classification = 'Discrepancy'
        }
      } else {
        // Unmatched ticket - mark as discrepancy for visibility
        classification = 'Discrepancy'
      }

      return {
        ticketId: ticket.ticket_id || '',
        amount: ticket.amount_collected || 0,
        date: ticket.date || '',
        classification,
        actualDrop,
        discrepancy,
        discrepancyPercent,
        isMatched: !!matchedDropPeriod,
      }
    })
  }, [selectedCauldron, tickets, chartData])

  const selectedCauldronData = cauldrons?.find(c => c && c.id === selectedCauldron) || null
  const maxVolume = selectedCauldronData?.max_volume || 100

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const CustomTooltip = ({ active, payload }: any) => {
    // Check if hovering over a ticket bar
    if (hoveredTicket) {
      // Find the drop period and calculate discrepancy if it's a matched ticket
      let discrepancyInfo: { actualDrop: number; ticketAmount: number; discrepancy: number; discrepancyPercent: number } | null = null
      
      if (chartData.dropPeriods) {
        for (const dropPeriod of chartData.dropPeriods) {
          const ticketInfo = chartData.ticketsByDropPeriod?.get(dropPeriod.startIndex)
          if (ticketInfo && ticketInfo.ticketId === hoveredTicket.ticketId) {
            const timeDiff = (dropPeriod.endTime - dropPeriod.startTime) / (1000 * 60) // minutes
            const fillDuringDrop = chartData.fillRate * timeDiff
            const actualDropAmount = dropPeriod.dropAmount + fillDuringDrop
            const discrepancy = Math.abs(actualDropAmount - ticketInfo.amount)
            const maxAmount = Math.max(actualDropAmount, ticketInfo.amount)
            const discrepancyPercent = maxAmount > 0 ? (discrepancy / maxAmount) * 100 : 0
            
            discrepancyInfo = {
              actualDrop: actualDropAmount,
              ticketAmount: ticketInfo.amount,
              discrepancy,
              discrepancyPercent
            }
            break
          }
        }
      }
      
      return (
        <Card className="p-3 border-border bg-card shadow-lg">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium">
              Ticket Information
            </p>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ backgroundColor: 'rgba(34, 197, 94, 0.5)' }} />
              <span className="text-sm font-medium">
                Ticket {hoveredTicket.ticketId.split('_').pop() || hoveredTicket.ticketId}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Ticketed Amount: <span className="font-semibold text-foreground">{hoveredTicket.amount.toFixed(2)}L</span>
            </div>
            {discrepancyInfo && (
              <>
                <div className="text-xs text-muted-foreground">
                  Actual Drop: <span className="font-semibold text-foreground">{discrepancyInfo.actualDrop.toFixed(2)}L</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Discrepancy: <span className="font-semibold text-foreground">{discrepancyInfo.discrepancy.toFixed(2)}L</span>
                  <span className={`ml-2 font-semibold ${
                    discrepancyInfo.discrepancyPercent >= 20 ? 'text-red-500' :
                    'text-green-500'
                  }`}>
                    ({discrepancyInfo.discrepancyPercent.toFixed(1)}%)
                  </span>
                </div>
              </>
            )}
            <div className="text-xs text-muted-foreground">
              Time: {formatTime(hoveredTicket.timestamp)}
            </div>
          </div>
        </Card>
      )
    }

    if (active && payload && payload.length) {
      const actualEntry = payload.find((entry: any) => entry.dataKey === 'actual')
      const dropPeriod = chartData.dropPeriods?.find(dp => 
        dp.startTime <= payload[0].payload.timestamp && dp.endTime >= payload[0].payload.timestamp
      )
      const ticketInfo = dropPeriod ? chartData.ticketsByDropPeriod?.get(dropPeriod.startIndex) : null

      return (
        <Card className="p-3 border-border bg-card shadow-lg">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium">
              {payload[0]?.payload?.time ? formatTime(new Date(payload[0].payload.time).getTime()) : ''}
            </p>
            {actualEntry && (
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: actualEntry.color }}
                />
                <span className="text-sm font-medium">
                  {actualEntry.name}: {actualEntry.value.toFixed(2)}L
                </span>
              </div>
            )}
            {dropPeriod && (
              <div className="pt-2 border-t border-border">
                <span className="text-xs text-muted-foreground">
                  Actual Drop: {dropPeriod.dropAmount.toFixed(2)}L
                </span>
              </div>
            )}
            {ticketInfo && (
              <div className="text-xs text-muted-foreground">
                Expected Drop (Ticket {ticketInfo.ticketId.split('_').pop()}): {ticketInfo.amount.toFixed(2)}L
              </div>
            )}
          </div>
        </Card>
      )
    }
    return null
  }

  return (
    <div className="space-y-6">
      {/* Subheading */}
      <p className="text-muted-foreground">Interactive graphs showing actual vs expected drops from ticket data</p>
      
      <div className="flex gap-4 relative">
        {/* Left edge hover zone for auto-toggle with cauldron icons when closed */}
        {!sidebarOpen && (
          <div 
            className="fixed left-0 top-1/2 -translate-y-1/2 z-40 cursor-pointer group"
            onMouseEnter={() => setSidebarOpen(true)}
          >
            <div className="bg-card border border-border rounded-r-lg p-3 shadow-lg hover:bg-primary/10 transition-colors flex flex-col gap-2 items-center max-h-[80vh] overflow-y-auto">
              {cauldrons.map((cauldron, idx) => {
                if (!cauldron.id) return null
                const color = getCauldronColor(idx)
                const isSelected = selectedCauldron === cauldron.id
                const cauldronNumber = cauldron.id.split('_').pop()?.replace('cauldron', '') || ''
                return (
                  <div
                    key={cauldron.id}
                    className="flex flex-col items-center gap-1"
                  >
                    <Droplets
                      className={`h-5 w-5 transition-all ${
                        isSelected ? 'opacity-100 scale-110' : 'opacity-70'
                      }`}
                      style={{ color }}
                      fill={isSelected ? color : 'none'}
                    />
                    <span 
                      className={`text-[10px] font-semibold ${
                        isSelected ? 'opacity-100' : 'opacity-60'
                      }`}
                      style={{ color }}
                    >
                      {cauldronNumber}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        
        {/* Cauldron Selection Sidebar - Toggleable */}
        {sidebarOpen && (
          <Card 
            className="p-3 border-border bg-card w-[200px] shrink-0 z-30"
            onMouseEnter={() => {
              // Clear any hide timeout when mouse enters sidebar
              if (hoverTimeout) {
                clearTimeout(hoverTimeout)
                setHoverTimeout(null)
              }
            }}
            onMouseLeave={() => {
              // Hide sidebar when mouse leaves (with delay)
              const timeout = setTimeout(() => {
                setSidebarOpen(false)
              }, 300)
              setHoverTimeout(timeout)
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-muted-foreground">Cauldrons</h3>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setSidebarOpen(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
            <ScrollArea className="h-[600px]">
              <div className="space-y-1.5">
                {cauldrons.map((cauldron, idx) => {
                if (!cauldron.id) return null
                const isSelected = selectedCauldron === cauldron.id
                const color = getCauldronColor(idx)
                
                // Extract short cauldron name/number
                // Try to get a short name from the cauldron name, or use the number
                let shortName = cauldron.name || cauldron.id
                // If name is long, try to extract a short version (e.g., "Azure Breeze Cauldron" -> "Azure")
                if (shortName.includes(' ')) {
                  const parts = shortName.split(' ')
                  shortName = parts[0] // Take first word
                }
                // Add number if available
                const cauldronNumber = cauldron.id.split('_').pop()?.replace('cauldron', '') || ''
                const displayName = cauldronNumber ? `${shortName} ${cauldronNumber}` : shortName
                
                return (
                  <div
                    key={cauldron.id}
                    className={`relative rounded-md border transition-all cursor-pointer group ${
                      isSelected 
                        ? 'border-primary bg-primary/10 shadow-sm' 
                        : 'border-border hover:border-primary hover:bg-primary/5'
                    }`}
                    onClick={() => setSelectedCauldron(cauldron.id)}
                  >
                    {/* Color indicator bar on the left */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l-md"
                      style={{ backgroundColor: color }}
                    />
                    
                    <div className="pl-3 pr-2 py-2">
                      <div className="flex items-center gap-2">
                        <Droplets
                          className={`h-4 w-4 shrink-0 transition-all ${
                            isSelected ? 'opacity-100 scale-110' : 'opacity-70'
                          }`}
                          style={{ color }}
                          fill={isSelected ? color : 'none'}
                        />
                        <span className={`font-medium text-xs truncate ${
                          isSelected ? 'text-primary font-semibold' : 'text-foreground'
                        }`}>
                          {displayName}
                        </span>
                      </div>
                    </div>
                  </div>
                )
                })}
              </div>
            </ScrollArea>
          </Card>
        )}
        

        {/* Chart Area */}
        <div className={`space-y-4 flex-1 min-w-0 ${!sidebarOpen ? 'ml-20' : ''} ${!rightSidebarOpen ? 'mr-20' : ''}`}>
            {/* Main Chart */}
            <Card className="p-6 bg-background/80 backdrop-blur-sm border-purple-500/30">
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">
                Potion Level Over Time
                {selectedCauldronData && (
                  <span className="text-sm text-muted-foreground font-normal ml-2">
                    (Cauldron {selectedCauldronData.id?.split('_').pop()?.replace('cauldron', '') || selectedCauldronData.id})
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#3b82f6' }} />
                  <span className="text-muted-foreground">Actual Level</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: 'rgba(16, 185, 129, 0.3)' }} />
                  <span className="text-muted-foreground">Normal (&lt;20%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: 'rgba(239, 68, 68, 0.3)' }} />
                  <span className="text-muted-foreground">Discrepancy (&gt;=20%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full opacity-50" style={{ backgroundColor: '#8b5cf6' }} />
                  <span className="text-muted-foreground">Max Volume</span>
                </div>
              </div>
            </div>
            <div className="h-[500px]">
              {chartData.data && chartData.data.length > 0 ? (
                <div className="relative w-full h-full">
                  {isAnimating && (
                    <div className="absolute top-2 right-2 z-10 bg-purple-500/80 text-white text-xs px-2 py-1 rounded">
                      Plotting... {Math.round((visibleDataPoints / chartData.data.length) * 100)}%
                    </div>
                  )}
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart 
                      data={chartData.data.slice(0, Math.max(visibleDataPoints, 1))} 
                    margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                    onMouseMove={(e: any) => {
                      if (!e || !e.activeCoordinate) {
                        setHoveredTicket(null)
                        return
                      }
                      
                      const mouseX = e.activeCoordinate.x
                      const mouseY = e.activeCoordinate.y
                      
                      // Convert timestamps to pixel coordinates (approximate)
                      // Using chart width of ~500px (accounting for margins)
                      const chartWidth = 500
                      const chartHeight = 400
                      const xScale = (dataEndTime - dataStartTime) / chartWidth // milliseconds per pixel
                      const yScale = (maxVolume * 1.1) / chartHeight // liters per pixel
                      
                      // Check if mouse is over any ticket bar
                      // First check unmatched tickets (dashed bars)
                      for (const ticket of chartData.unmatchedTickets || []) {
                        const barWidth = 30 * 60 * 1000 // 30 minutes in milliseconds
                        const x1 = ticket.timestamp - barWidth
                        const x2 = ticket.timestamp + barWidth
                        
                        const ticketX1 = ((x1 - dataStartTime) / xScale) + 20 // account for left margin
                        const ticketX2 = ((x2 - dataStartTime) / xScale) + 20
                        
                        if (mouseX >= Math.min(ticketX1, ticketX2) && mouseX <= Math.max(ticketX1, ticketX2)) {
                          // Check Y position (approximate)
                          const ticketY1 = chartHeight - (ticket.level / yScale) + 5 // account for top margin
                          const ticketY2 = chartHeight - ((ticket.level - ticket.amount) / yScale) + 5
                          
                          if (mouseY >= Math.min(ticketY1, ticketY2) && mouseY <= Math.max(ticketY1, ticketY2)) {
                            setHoveredTicket({
                              ticketId: ticket.ticketId,
                              amount: ticket.amount,
                              timestamp: ticket.timestamp
                            })
                            return
                          }
                        }
                      }
                      
                      // Check expected drops (matched tickets)
                      for (const dropPeriod of chartData.dropPeriods || []) {
                        const ticketInfo = chartData.ticketsByDropPeriod?.get(dropPeriod.startIndex)
                        if (!ticketInfo) continue
                        
                        const x1 = dropPeriod.startTime
                        const x2 = dropPeriod.endTime
                        const ticketX1 = ((x1 - dataStartTime) / xScale) + 20
                        const ticketX2 = ((x2 - dataStartTime) / xScale) + 20
                        
                        if (mouseX >= Math.min(ticketX1, ticketX2) && mouseX <= Math.max(ticketX1, ticketX2)) {
                          const y1 = dropPeriod.startLevel
                          const y2 = dropPeriod.startLevel - ticketInfo.amount
                          const ticketY1 = chartHeight - (y1 / yScale) + 5
                          const ticketY2 = chartHeight - (y2 / yScale) + 5
                          
                          if (mouseY >= Math.min(ticketY1, ticketY2) && mouseY <= Math.max(ticketY1, ticketY2)) {
                            setHoveredTicket({
                              ticketId: ticketInfo.ticketId,
                              amount: ticketInfo.amount,
                              timestamp: dropPeriod.startTime
                            })
                            return
                          }
                        }
                      }
                      
                      setHoveredTicket(null)
                    }}
                    onMouseLeave={() => setHoveredTicket(null)}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(150, 150, 150, 0.1)" />
                    <XAxis
                      dataKey="timestamp"
                      type="number"
                      domain={[dataStartTime, dataEndTime]}
                      tickFormatter={(value) => {
                        const date = new Date(value)
                        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      }}
                      stroke="rgba(200, 200, 200, 0.6)"
                      style={{ fontSize: '12px' }}
                    />
                    <YAxis
                      domain={[0, maxVolume * 1.1]}
                      stroke="rgba(200, 200, 200, 0.6)"
                      style={{ fontSize: '12px' }}
                      label={{ value: 'Volume (L)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <ReferenceLine
                      y={maxVolume}
                      stroke="rgba(139, 92, 246, 0.3)"
                      strokeDasharray="5 5"
                      label={{ value: 'Max Volume', position: 'right' }}
                    />
                    {selectedCauldron && (
                      <Line
                        type="monotone"
                        dataKey="actual"
                        stroke={getCauldronColor(cauldrons.findIndex(c => c.id === selectedCauldron))}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 6 }}
                        name="Actual Level"
                        animationDuration={isAnimating ? 100 : 300}
                        isAnimationActive={true}
                      />
                    )}
                    {/* Render translucent bars for expected drops (from ticket data matched to drops) */}
                    {/* Only show after animation completes */}
                    {!isAnimating && chartData.dropPeriods?.map((dropPeriod, idx) => {
                      const ticketInfo = chartData.ticketsByDropPeriod?.get(dropPeriod.startIndex)
                      
                      // Only show bars for drops that have matching tickets (expected drops)
                      if (!ticketInfo || ticketInfo.amount <= 0) return null
                      
                      // Calculate actual drop amount (accounting for fill during drop)
                      const timeDiff = (dropPeriod.endTime - dropPeriod.startTime) / (1000 * 60) // minutes
                      const fillDuringDrop = chartData.fillRate * timeDiff
                      const actualDropAmount = dropPeriod.dropAmount + fillDuringDrop
                      
                      // Calculate discrepancy between actual drop and ticketed amount
                      const discrepancy = Math.abs(actualDropAmount - ticketInfo.amount)
                      const maxAmount = Math.max(actualDropAmount, ticketInfo.amount)
                      const discrepancyPercent = maxAmount > 0 ? (discrepancy / maxAmount) * 100 : 0
                      
                      // Color code based on discrepancy
                      // Normal: < 20% difference (green)
                      // Discrepancy: >= 20% difference (red/orange)
                      let fillColor = 'rgba(16, 185, 129, 0.3)' // green - normal
                      let strokeColor = 'rgba(16, 185, 129, 0.6)'
                      let labelColor = 'rgba(16, 185, 129, 0.9)'
                      
                      if (discrepancyPercent >= 20) {
                        // Discrepancy (medium + high) - red/orange
                        fillColor = 'rgba(239, 68, 68, 0.3)'
                        strokeColor = 'rgba(239, 68, 68, 0.6)'
                        labelColor = 'rgba(239, 68, 68, 0.9)'
                      }
                      
                      // Calculate Y positions: bar shows expected decrease from ticket
                      // Bar starts at the level when drop begins
                      // Bar height represents the ticket amount (expected decrease)
                      const y1 = dropPeriod.startLevel
                      const y2 = dropPeriod.startLevel - ticketInfo.amount
                      const ticketNumber = ticketInfo.ticketId.split('_').pop() || ticketInfo.ticketId
                      
                      return (
                        <ReferenceArea
                          key={`expected-drop-${idx}`}
                          x1={dropPeriod.startTime}
                          x2={dropPeriod.endTime}
                          y1={Math.max(y1, y2)}
                          y2={Math.min(y1, y2)}
                          fill={fillColor}
                          stroke={strokeColor}
                          strokeWidth={1}
                          label={{ 
                            value: ticketNumber, 
                            position: 'insideTop',
                            fill: labelColor,
                            fontSize: 11,
                            fontWeight: 'bold'
                          }}
                        />
                      )
                    })}
                    
                    {/* Render bars for unmatched tickets (at ticket timestamps) */}
                    {/* Only show after animation completes */}
                    {!isAnimating && chartData.unmatchedTickets?.map((ticket, idx) => {
                      // Use the level we already calculated when creating allTickets
                      const actualLevelAtTicket = ticket.level
                      
                      // Calculate Y positions: bar shows ticket amount
                      const y1 = actualLevelAtTicket
                      const y2 = actualLevelAtTicket - ticket.amount
                      const ticketNumber = ticket.ticketId.split('_').pop() || ticket.ticketId
                      
                      // Bar width: 30 minutes on each side of ticket timestamp
                      const barWidth = 30 * 60 * 1000 // 30 minutes in milliseconds
                      
                      return (
                        <ReferenceArea
                          key={`ticket-${idx}`}
                          x1={ticket.timestamp - barWidth}
                          x2={ticket.timestamp + barWidth}
                          y1={Math.max(y1, y2)}
                          y2={Math.min(y1, y2)}
                          fill="rgba(34, 197, 94, 0.25)"
                          stroke="rgba(34, 197, 94, 0.5)"
                          strokeWidth={1}
                          strokeDasharray="3 3"
                          label={{ 
                            value: `T${ticketNumber}`, 
                            position: 'insideTop',
                            fill: 'rgba(34, 197, 94, 0.9)',
                            fontSize: 10,
                            fontWeight: 'bold'
                          }}
                        />
                      )
                    })}
                  </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p>No data available for selected cauldron</p>
                </div>
              )}
            </div>
          </Card>

        </div>

        {/* Right edge hover zone for auto-toggle with ticket icon when closed */}
        {!rightSidebarOpen && (
          <div 
            className="fixed right-0 top-1/2 -translate-y-1/2 z-40 cursor-pointer group"
            onMouseEnter={() => setRightSidebarOpen(true)}
          >
            <div className="bg-card border border-border rounded-l-lg p-3 shadow-lg hover:bg-primary/10 transition-colors">
              <div className="flex flex-col items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-xs font-bold text-primary">T</span>
                </div>
                <span className="text-[10px] font-semibold text-muted-foreground writing-vertical-rl">
                  Tickets
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Tickets Sidebar - Toggleable - Only show after animation completes */}
        {rightSidebarOpen && !isAnimating && (
          <Card 
            className="p-3 border-border bg-card w-[280px] shrink-0 z-30"
            onMouseEnter={() => {
              // Clear any hide timeout when mouse enters sidebar
              if (rightHoverTimeout) {
                clearTimeout(rightHoverTimeout)
                setRightHoverTimeout(null)
              }
            }}
            onMouseLeave={() => {
              // Hide sidebar when mouse leaves (with delay)
              const timeout = setTimeout(() => {
                setRightSidebarOpen(false)
              }, 300)
              setRightHoverTimeout(timeout)
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-muted-foreground">Ticket Data</h3>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setRightSidebarOpen(false)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <ScrollArea className="h-[600px]">
              {ticketData.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No tickets available for selected cauldron
                </div>
              ) : (
                <div className="space-y-2">
                  {ticketData.map((ticket) => {
                    const ticketNumber = ticket.ticketId.split('_').pop() || ticket.ticketId
                    const date = new Date(ticket.date)
                    const isNormal = ticket.classification === 'Normal'
                    
                    return (
                      <div
                        key={ticket.ticketId}
                        className={`rounded-md border p-3 transition-all ${
                          isNormal
                            ? 'border-green-500/30 bg-green-500/5'
                            : 'border-red-500/30 bg-red-500/5'
                        }`}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                              isNormal
                                ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                                : 'bg-red-500/20 text-red-600 dark:text-red-400'
                            }`}>
                              {ticket.classification}
                            </span>
                            <span className="text-xs font-medium text-muted-foreground">
                              Ticket {ticketNumber}
                            </span>
                          </div>
                        </div>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Ticketed:</span>
                            <span className="font-semibold">{ticket.amount.toFixed(2)}L</span>
                          </div>
                          {ticket.isMatched && (
                            <>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Actual Drop:</span>
                                <span className="font-semibold">{ticket.actualDrop.toFixed(2)}L</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Discrepancy:</span>
                                <span className={`font-semibold ${
                                  isNormal ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                                }`}>
                                  {ticket.discrepancy.toFixed(2)}L ({ticket.discrepancyPercent.toFixed(1)}%)
                                </span>
                              </div>
                            </>
                          )}
                          <div className="flex justify-between pt-1 border-t border-border/50">
                            <span className="text-muted-foreground">Date:</span>
                            <span className="font-medium">
                              {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          </div>
                          {!ticket.isMatched && (
                            <div className="text-xs text-muted-foreground italic pt-1">
                              Unmatched ticket
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </Card>
        )}
      </div>
    </div>
  )
}

