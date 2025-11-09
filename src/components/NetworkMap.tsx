import { useEffect, useRef, useState, useMemo } from 'react'
import { Badge } from './ui/badge'
import type { CauldronDto, NetworkDto, CourierDto, CauldronLevelsDto, TicketDto, MarketDto } from '../types/api'
import type { Alert } from '../utils/realtimeMonitoring'
import type { Discrepancy } from '../utils/audit'

interface Route {
  courierId: string
  courierName: string
  stops: Array<{
    cauldronId: string
    cauldronName: string
    arrivalTime: number
    pickupVolume: number
  }>
  color?: string
}

interface NetworkMapProps {
  currentTime: number
  onCauldronSelect: (id: string | null) => void
  selectedCauldron: string | null
  cauldrons: CauldronDto[]
  network: NetworkDto | null
  couriers: CourierDto[]
  currentLevels: CauldronLevelsDto | Record<string, number>
  tickets?: TicketDto[]
  currentTimestamp?: Date | null
  market?: MarketDto | null
  alerts?: Alert[] // Active alerts for warning icons
  discrepancies?: Discrepancy[] // Discrepancies for warning signs
  routes?: Route[] // Optimal routes from optimization
  cauldronRiskLevels?: Map<string, 'low' | 'medium' | 'high'> // Risk levels for status colors
}

export default function NetworkMap({
  currentTime,
  onCauldronSelect,
  selectedCauldron,
  cauldrons,
  network,
  couriers,
  currentLevels,
  tickets = [],
  currentTimestamp,
  market,
  alerts = [],
  discrepancies = [],
  routes = [],
  cauldronRiskLevels = new Map(),
}: NetworkMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoveredCauldron, setHoveredCauldron] = useState<string | null>(null)
  
  // Track cauldrons with recent discrepancies (within 5 seconds of when they first appear)
  const cauldronsWithRecentDiscrepancies = useMemo(() => {
    if (!currentTimestamp || discrepancies.length === 0) return new Set<string>()
    
    const recentCauldrons = new Set<string>()
    const currentTimeMs = currentTimestamp.getTime()
    const fiveSecondsInMs = 5000
    
    discrepancies.forEach(disc => {
      const discDate = new Date(disc.date)
      const discTimeMs = discDate.getTime()
      
      // Check if discrepancy date is at or before current timestamp (discrepancy is visible)
      // and within 5 seconds of when it first appeared
      if (discTimeMs <= currentTimeMs) {
        const timeSinceAppearance = currentTimeMs - discTimeMs
        // Show warning if discrepancy appeared within the last 5 seconds
        if (timeSinceAppearance <= fiveSecondsInMs) {
          // Get cauldron ID from ticket
          const ticket = tickets.find(t => t.ticket_id === disc.ticketId)
          if (ticket?.cauldron_id) {
            recentCauldrons.add(ticket.cauldron_id)
          }
        }
      }
    })
    
    return recentCauldrons
  }, [discrepancies, currentTimestamp, tickets])

  // Calculate cauldron and market positions from latitude/longitude with proper axis scaling
  const { cauldronPositions, marketPosition, axisInfo } = useMemo(() => {
    const defaultAxisInfo = {
      minLat: 0,
      maxLat: 0,
      minLong: 0,
      maxLong: 0,
      axisLabelWidth: 80,
      axisLabelHeight: 40,
      padding: 20,
      usableWidth: 700,
      usableHeight: 540,
    }
    
    if (cauldrons.length === 0) {
      return { 
        cauldronPositions: new Map<string, { x: number; y: number }>(),
        marketPosition: null,
        axisInfo: defaultAxisInfo
      }
    }

    // Find min/max lat/long for normalization (include market if available)
    const lats = [...cauldrons.map(c => c.latitude)]
    const longs = [...cauldrons.map(c => c.longitude)]
    if (market) {
      lats.push(market.latitude)
      longs.push(market.longitude)
    }
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const minLong = Math.min(...longs)
    const maxLong = Math.max(...longs)

    const latRange = maxLat - minLat || 0.01
    const longRange = maxLong - minLong || 0.01

    // Add padding to ensure good spacing (15% padding)
    const latPadding = latRange * 0.15
    const longPadding = longRange * 0.15
    const adjustedMinLat = minLat - latPadding
    const adjustedMaxLat = maxLat + latPadding
    const adjustedMinLong = minLong - longPadding
    const adjustedMaxLong = maxLong + longPadding
    const adjustedLatRange = adjustedMaxLat - adjustedMinLat
    const adjustedLongRange = adjustedMaxLong - adjustedMinLong

    // Canvas dimensions with space for axis labels - use larger width for better horizontal scaling
    const axisLabelWidth = 80
    const axisLabelHeight = 40
    const padding = 20
    // Use a larger base width to allow the map to scale horizontally
    const baseWidth = 1600
    const baseHeight = 600
    const usableWidth = baseWidth - axisLabelWidth - padding * 2
    const usableHeight = baseHeight - axisLabelHeight - padding * 2

    const positions = new Map<string, { x: number; y: number }>()

    cauldrons.forEach((cauldron) => {
      if (!cauldron.id) return

      // Verify cauldron has valid coordinates
      if (isNaN(cauldron.latitude) || isNaN(cauldron.longitude)) {
        console.warn(`Cauldron ${cauldron.id} has invalid coordinates`)
        return
      }

      // Normalize lat/long to 0-1 range with padding
      const normalizedLat = (cauldron.latitude - adjustedMinLat) / adjustedLatRange
      const normalizedLong = (cauldron.longitude - adjustedMinLong) / adjustedLongRange

      // Convert to canvas coordinates (flip Y axis since canvas Y increases downward)
      // X axis: longitude (left to right)
      // Y axis: latitude (bottom to top, but flipped for canvas)
      const x = axisLabelWidth + padding + normalizedLong * usableWidth
      const y = padding + (1 - normalizedLat) * usableHeight // Flip Y

      positions.set(cauldron.id, { x, y })
    })

    // Calculate market position if available
    let marketPos: { x: number; y: number } | null = null
    if (market) {
      // Verify market has valid coordinates
      if (!isNaN(market.latitude) && !isNaN(market.longitude)) {
        const normalizedLat = (market.latitude - adjustedMinLat) / adjustedLatRange
        const normalizedLong = (market.longitude - adjustedMinLong) / adjustedLongRange
        const x = axisLabelWidth + padding + normalizedLong * usableWidth
        const y = padding + (1 - normalizedLat) * usableHeight
        marketPos = { x, y }
      } else {
        console.warn('Market has invalid coordinates')
      }
    }

    return { 
      cauldronPositions: positions,
      marketPosition: marketPos,
      axisInfo: {
        minLat: adjustedMinLat,
        maxLat: adjustedMaxLat,
        minLong: adjustedMinLong,
        maxLong: adjustedMaxLong,
        axisLabelWidth,
        axisLabelHeight,
        padding,
        usableWidth,
        usableHeight,
      }
    }
  }, [cauldrons, market])

  // Calculate courier positions based on tickets, network edges, and current timestamp
  // This properly tracks courier movement: at cauldron when ticket created, then traveling to destination
  const courierPositions = useMemo(() => {
    if (!currentTimestamp || tickets.length === 0 || couriers.length === 0 || !network?.edges) {
      return new Map<string, { x: number; y: number, color: string, isTraveling?: boolean }>()
    }

    const courierColors = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#8b5cf6']
    const positions = new Map<string, { x: number; y: number, color: string, isTraveling?: boolean }>()

    // Get active tickets sorted by date
    const activeTickets = tickets
      .filter(ticket => {
        if (!ticket.date || !ticket.courier_id || !ticket.cauldron_id) return false
        const ticketDate = new Date(ticket.date)
        return ticketDate <= currentTimestamp
      })
      .sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0
        const dateB = b.date ? new Date(b.date).getTime() : 0
        return dateA - dateB
      })

    // For each courier, find their current position based on tickets and travel
    couriers.forEach((courier, idx) => {
      if (!courier.courier_id) return

      const color = courierColors[idx % courierColors.length] || '#3b82f6'
      const courierTickets = activeTickets.filter(t => t.courier_id === courier.courier_id)

      if (courierTickets.length === 0) {
        // No tickets yet - position at market (starting point)
        if (marketPosition) {
          positions.set(courier.courier_id, { ...marketPosition, color })
        } else {
          // Fallback to first cauldron if no market
          const firstCauldron = cauldrons[0]
          if (firstCauldron?.id) {
            const pos = cauldronPositions.get(firstCauldron.id)
            if (pos) {
              positions.set(courier.courier_id, { ...pos, color })
            }
          }
        }
        return
      }

      // Process tickets in chronological order to track courier's journey
      // A ticket represents: courier arrives at cauldron, collects potion, then travels to destination
      const currentTimeMs = currentTimestamp.getTime()
      let currentPos: { x: number; y: number } | null = null
      let isTraveling = false

      // Find the most relevant ticket/edge for current time
      for (let i = courierTickets.length - 1; i >= 0; i--) {
        const ticket = courierTickets[i]
        if (!ticket.cauldron_id || !ticket.date) continue

        const ticketTime = new Date(ticket.date).getTime()
        const timeSinceTicket = (currentTimeMs - ticketTime) / (1000 * 60) // minutes

        // Find edges from this cauldron (could go to market or another cauldron)
        const outgoingEdges = (network?.edges || []).filter(e => e.from === ticket.cauldron_id)
        
        if (outgoingEdges.length === 0) {
          // No outgoing edge - courier stays at cauldron
          const sourcePos = cauldronPositions.get(ticket.cauldron_id)
          if (sourcePos) {
            currentPos = sourcePos
            break
          }
        }

        // Check each outgoing edge to see if courier is traveling on it
        for (const edge of outgoingEdges) {
          if (!edge.to || edge.travel_time_minutes <= 0) continue

          // Courier is at cauldron when ticket is created, then travels
          // If time since ticket is less than travel time, courier is traveling
          if (timeSinceTicket >= 0 && timeSinceTicket < edge.travel_time_minutes) {
            // Courier is traveling on this edge
            const sourcePos = cauldronPositions.get(ticket.cauldron_id)
            if (!sourcePos) continue

            let destPos: { x: number; y: number } | null = null
            if (market && edge.to === market.id) {
              destPos = marketPosition
            } else {
              destPos = cauldronPositions.get(edge.to) || null
            }

            if (destPos) {
              const travelProgress = timeSinceTicket / edge.travel_time_minutes
              const x = sourcePos.x + (destPos.x - sourcePos.x) * travelProgress
              const y = sourcePos.y + (destPos.y - sourcePos.y) * travelProgress
              
              currentPos = { x, y }
              isTraveling = true
              break
            }
          } else if (timeSinceTicket >= edge.travel_time_minutes) {
            // Courier has reached destination
            let destPos: { x: number; y: number } | null = null
            if (market && edge.to === market.id) {
              destPos = marketPosition
            } else {
              destPos = cauldronPositions.get(edge.to) || null
            }

            if (destPos) {
              currentPos = destPos
              // Check if there's a next ticket/edge from this destination
              // For now, courier stays at destination
              break
            }
          }
        }

        // If we found a position for this ticket, use it
        if (currentPos) break
      }

      // If no position found from tickets, use the most recent ticket's cauldron
      if (!currentPos && courierTickets.length > 0) {
        const latestTicket = courierTickets[courierTickets.length - 1]
        if (latestTicket.cauldron_id) {
          const sourcePos = cauldronPositions.get(latestTicket.cauldron_id)
          if (sourcePos) {
            currentPos = sourcePos
          }
        }
      }

      if (currentPos) {
        positions.set(courier.courier_id, { 
          ...currentPos, 
          color, 
          isTraveling 
        })
      }
    })

    return positions
  }, [tickets, currentTimestamp, couriers, cauldrons, cauldronPositions, network, market, marketPosition])

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    // Get mouse position relative to canvas (no DPR scaling needed for event coordinates)
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Check which cauldron is hovered
    // We need to use the same scaling logic as in the drawing code
    const { axisLabelWidth, padding, usableWidth, usableHeight } = axisInfo
    const actualUsableWidth = rect.width - axisLabelWidth - padding * 2
    const actualUsableHeight = rect.height - axisInfo.axisLabelHeight - padding * 2
    const scaleX = actualUsableWidth / usableWidth
    const scaleY = actualUsableHeight / usableHeight

    let hovered: string | null = null
    cauldronPositions.forEach((basePos, cauldronId) => {
      // Scale position to match actual canvas display coordinates
      const scaledPos = {
        x: axisLabelWidth + padding + (basePos.x - axisLabelWidth - padding) * scaleX,
        y: padding + (basePos.y - padding) * scaleY
      }
      const distance = Math.sqrt((scaledPos.x - x) ** 2 + (scaledPos.y - y) ** 2)
      // Increase hit radius for better clickability
      if (distance < 40) {
        hovered = cauldronId
      }
    })

    setHoveredCauldron(hovered)
  }

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    // Get click position relative to canvas (no DPR scaling needed for event coordinates)
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Check which cauldron was clicked
    // We need to use the same scaling logic as in the drawing code
    const { axisLabelWidth, padding, usableWidth, usableHeight } = axisInfo
    const actualUsableWidth = rect.width - axisLabelWidth - padding * 2
    const actualUsableHeight = rect.height - axisInfo.axisLabelHeight - padding * 2
    const scaleX = actualUsableWidth / usableWidth
    const scaleY = actualUsableHeight / usableHeight

    let clickedCauldron: string | null = null
    cauldronPositions.forEach((basePos, cauldronId) => {
      // Scale position to match actual canvas display coordinates
      const scaledPos = {
        x: axisLabelWidth + padding + (basePos.x - axisLabelWidth - padding) * scaleX,
        y: padding + (basePos.y - padding) * scaleY
      }
      const distance = Math.sqrt((scaledPos.x - x) ** 2 + (scaledPos.y - y) ** 2)
      // Increase hit radius for better clickability
      if (distance < 40) {
        clickedCauldron = cauldronId
      }
    })

    if (clickedCauldron !== null) {
      onCauldronSelect(clickedCauldron === selectedCauldron ? null : clickedCauldron)
    } else {
      // Clicked outside any cauldron, deselect
      onCauldronSelect(null)
    }
  }

      // Canvas drawing
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const dpr = window.devicePixelRatio || 1
        const rect = canvas.getBoundingClientRect()
        // Scale canvas to fill available width
        const targetWidth = rect.width
        const targetHeight = 600 // Fixed height
        canvas.width = targetWidth * dpr
        canvas.height = targetHeight * dpr
        ctx.scale(dpr, dpr)

        // Clear canvas
        ctx.clearRect(0, 0, targetWidth, targetHeight)
        
        // Update axisInfo with actual canvas dimensions for proper scaling
        const actualAxisInfo = {
          ...axisInfo,
          usableWidth: targetWidth - axisInfo.axisLabelWidth - axisInfo.padding * 2,
          usableHeight: targetHeight - axisInfo.axisLabelHeight - axisInfo.padding * 2,
        }
        
        // Calculate scale factors for horizontal and vertical scaling
        const scaleX = actualAxisInfo.usableWidth / axisInfo.usableWidth
        const scaleY = actualAxisInfo.usableHeight / axisInfo.usableHeight
        
        // Extract axis info values for use throughout the drawing code
        const { axisLabelWidth, padding } = actualAxisInfo

        const edges = network?.edges || []
        
        // Draw axis labels and grid
        if (actualAxisInfo && actualAxisInfo.minLat !== 0 && actualAxisInfo.maxLat !== 0) {
          const { minLat, maxLat, minLong, maxLong, usableWidth, usableHeight } = actualAxisInfo
      
      // Draw grid lines
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.1)'
      ctx.lineWidth = 1
      
      // Vertical grid lines (longitude)
      const longSteps = 5
      for (let i = 0; i <= longSteps; i++) {
        const longValue = minLong + (maxLong - minLong) * (i / longSteps)
        const x = axisLabelWidth + padding + (i / longSteps) * usableWidth
        ctx.beginPath()
        ctx.moveTo(x, padding)
        ctx.lineTo(x, padding + usableHeight)
        ctx.stroke()
        
        // Longitude label
        ctx.fillStyle = 'rgba(200, 200, 200, 0.8)'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(longValue.toFixed(4), x, padding + usableHeight + 15)
      }
      
      // Horizontal grid lines (latitude)
      const latSteps = 5
      for (let i = 0; i <= latSteps; i++) {
        const latValue = minLat + (maxLat - minLat) * (i / latSteps)
        const y = padding + (1 - i / latSteps) * usableHeight
        ctx.beginPath()
        ctx.moveTo(axisLabelWidth + padding, y)
        ctx.lineTo(axisLabelWidth + padding + usableWidth, y)
        ctx.stroke()
        
        // Latitude label
        ctx.fillStyle = 'rgba(200, 200, 200, 0.8)'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(latValue.toFixed(4), axisLabelWidth + padding - 10, y + 3)
      }
      
      // Axis titles
      ctx.fillStyle = 'rgba(200, 200, 200, 0.9)'
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.save()
      ctx.translate(15, padding + usableHeight / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.fillText('Latitude', 0, 0)
      ctx.restore()
      
      ctx.textAlign = 'center'
      ctx.fillText('Longitude', axisLabelWidth + padding + usableWidth / 2, padding + usableHeight + 30)
    }

        // Draw edges (connect cauldrons and market based on network data)
        ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)'
        ctx.lineWidth = 1.5
        edges.forEach((edge) => {
          let baseFromPos: { x: number; y: number } | null = null
          let baseToPos: { x: number; y: number } | null = null
          
          // Check if from is a cauldron or market
          if (edge.from) {
            if (market && edge.from === market.id) {
              baseFromPos = marketPosition
            } else {
              baseFromPos = cauldronPositions.get(edge.from) || null
            }
          }
          
          // Check if to is a cauldron or market
          if (edge.to) {
            if (market && edge.to === market.id) {
              baseToPos = marketPosition
            } else {
              baseToPos = cauldronPositions.get(edge.to) || null
            }
          }
          
          if (baseFromPos && baseToPos) {
            // Scale positions to actual canvas dimensions
            const fromPos = {
              x: axisLabelWidth + padding + (baseFromPos.x - axisLabelWidth - padding) * scaleX,
              y: baseFromPos.y * scaleY
            }
            const toPos = {
              x: axisLabelWidth + padding + (baseToPos.x - axisLabelWidth - padding) * scaleX,
              y: baseToPos.y * scaleY
            }
            ctx.beginPath()
            ctx.moveTo(fromPos.x, fromPos.y)
            ctx.lineTo(toPos.x, toPos.y)
            ctx.stroke()
          }
        })

        // Draw optimal routes (if provided)
        if (routes.length > 0) {
          const routeColors = [
            '#8b5cf6', // purple
            '#3b82f6', // blue
            '#10b981', // green
            '#f59e0b', // yellow
            '#ef4444', // red
            '#ec4899', // pink
            '#06b6d4', // cyan
          ]
          
          routes.forEach((route, routeIdx) => {
            const routeColor = route.color || routeColors[routeIdx % routeColors.length]
            
            // Draw route path: Market -> Cauldrons -> Market
            ctx.strokeStyle = routeColor
            ctx.lineWidth = 3
            ctx.setLineDash([5, 5]) // Dashed line for routes
            
            // Start from market
            if (marketPosition) {
              let currentPos = {
                x: axisLabelWidth + padding + (marketPosition.x - axisLabelWidth - padding) * scaleX,
                y: marketPosition.y * scaleY
              }
              
              ctx.beginPath()
              ctx.moveTo(currentPos.x, currentPos.y)
              
              // Draw to each stop
              route.stops.forEach(stop => {
                const cauldronPos = cauldronPositions.get(stop.cauldronId)
                if (cauldronPos) {
                  const stopPos = {
                    x: axisLabelWidth + padding + (cauldronPos.x - axisLabelWidth - padding) * scaleX,
                    y: cauldronPos.y * scaleY
                  }
                  ctx.lineTo(stopPos.x, stopPos.y)
                  currentPos = stopPos
                }
              })
              
              // Return to market
              const marketPos = {
                x: axisLabelWidth + padding + (marketPosition.x - axisLabelWidth - padding) * scaleX,
                y: marketPosition.y * scaleY
              }
              ctx.lineTo(marketPos.x, marketPos.y)
              ctx.stroke()
              
              // Draw route waypoints (numbered stops)
              route.stops.forEach((stop, stopIdx) => {
                const cauldronPos = cauldronPositions.get(stop.cauldronId)
                if (cauldronPos) {
                  const stopPos = {
                    x: axisLabelWidth + padding + (cauldronPos.x - axisLabelWidth - padding) * scaleX,
                    y: cauldronPos.y * scaleY
                  }
                  
                  // Waypoint circle
                  ctx.fillStyle = routeColor
                  ctx.beginPath()
                  ctx.arc(stopPos.x, stopPos.y, 8, 0, Math.PI * 2)
                  ctx.fill()
                  
                  // Waypoint number
                  ctx.fillStyle = '#ffffff'
                  ctx.font = 'bold 10px sans-serif'
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'middle'
                  ctx.fillText((stopIdx + 1).toString(), stopPos.x, stopPos.y)
                }
              })
            }
          })
          
          ctx.setLineDash([]) // Reset line dash
        }

        // Draw couriers at their actual positions based on tickets and travel
        courierPositions.forEach((baseCourierPos, courierId) => {
          // Scale courier position to actual canvas dimensions
          const pos = {
            x: axisLabelWidth + padding + (baseCourierPos.x - axisLabelWidth - padding) * scaleX,
            y: baseCourierPos.y * scaleY,
            color: baseCourierPos.color,
            isTraveling: baseCourierPos.isTraveling
          }
      // Courier trail/aura (larger if traveling)
      const auraRadius = pos.isTraveling ? 70 : 50
      ctx.strokeStyle = pos.color + (pos.isTraveling ? '60' : '40')
      ctx.lineWidth = pos.isTraveling ? 3 : 2
      ctx.setLineDash([5, 5])
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, auraRadius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])

      // Courier dot (witches) - larger if traveling
      const courierRadius = pos.isTraveling ? 10 : 8
      ctx.fillStyle = pos.color
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, courierRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = pos.isTraveling ? 3 : 2
      ctx.stroke()

      // Courier ID label
      ctx.fillStyle = pos.color
      ctx.font = pos.isTraveling ? 'bold 11px sans-serif' : '10px sans-serif'
      ctx.textAlign = 'center'
      const courierName = courierId.split('_').pop() || courierId
      ctx.fillText(courierName, pos.x, pos.y - (courierRadius + 5))
      
      // Travel indicator
      if (pos.isTraveling) {
        ctx.fillStyle = pos.color + '80'
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, courierRadius + 3, 0, Math.PI * 2)
        ctx.fill()
      }
    })

        // Draw cauldrons
        cauldrons.forEach((cauldron) => {
          if (!cauldron.id) return

          const basePos = cauldronPositions.get(cauldron.id)
          if (!basePos) return
          
          // Scale position to actual canvas dimensions
          const pos = {
            x: axisLabelWidth + padding + (basePos.x - axisLabelWidth - padding) * scaleX,
            y: basePos.y * scaleY
          }

      // Get current level from historical data
      const levelKey = `cauldron_${cauldron.id.split('_').pop()?.padStart(3, '0') || '001'}`
      const currentLevel = (currentLevels as any)[levelKey] || 0
      const percentage = (currentLevel / cauldron.max_volume) * 100

      // Use risk level from optimization if available, otherwise use percentage-based status
      const riskLevel = cauldronRiskLevels.get(cauldron.id)
      let status: 'critical' | 'elevated' | 'safe'
      let color: string
      
      if (riskLevel) {
        // Use risk-based colors
        status = riskLevel === 'high' ? 'critical' : riskLevel === 'medium' ? 'elevated' : 'safe'
        color = riskLevel === 'high' ? '#ef4444' : riskLevel === 'medium' ? '#f59e0b' : '#10b981'
      } else {
        // Fallback to percentage-based
        status = percentage > 80 ? 'critical' : percentage > 60 ? 'elevated' : 'safe'
        color = status === 'critical' ? '#ef4444' : status === 'elevated' ? '#f59e0b' : '#10b981'
      }

      // Outer glow for selected/hovered
      if (selectedCauldron === cauldron.id || hoveredCauldron === cauldron.id) {
        ctx.shadowColor = color
        ctx.shadowBlur = 20
      }

      // Cauldron base
      const radius = 20 + (percentage / 100) * 10
      ctx.fillStyle = color + '20'
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2)
      ctx.fill()

      // Cauldron center
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2)
      ctx.fill()

      // Level indicator ring
      ctx.strokeStyle = color
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, 16, -Math.PI / 2, -Math.PI / 2 + (percentage / 100) * Math.PI * 2)
      ctx.stroke()

      ctx.shadowBlur = 0

      // Draw warning icon if cauldron has recent discrepancies (within 5 seconds)
      const hasRecentDiscrepancy = cauldronsWithRecentDiscrepancies.has(cauldron.id)
      
      // Draw warning icon if cauldron has active alerts or recent discrepancies
      const cauldronAlerts = alerts.filter(a => a.cauldronId === cauldron.id && a.severity !== 'info')
      if (cauldronAlerts.length > 0 || hasRecentDiscrepancy) {
        // Draw warning icon above cauldron
        const warningX = pos.x
        const warningY = pos.y - radius - 25
        
        // Warning icon background (pulsing effect)
        const warningColor = hasRecentDiscrepancy 
          ? '#f59e0b' // Yellow for discrepancies
          : cauldronAlerts.some(a => a.severity === 'critical') ? '#ef4444' : '#f59e0b'
        ctx.fillStyle = warningColor
        ctx.beginPath()
        ctx.arc(warningX, warningY, 12, 0, Math.PI * 2)
        ctx.fill()
        
        // Warning icon border
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 2
        ctx.stroke()
        
        // Warning triangle
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.moveTo(warningX, warningY - 6)
        ctx.lineTo(warningX - 5, warningY + 4)
        ctx.lineTo(warningX + 5, warningY + 4)
        ctx.closePath()
        ctx.fill()
        
        // Exclamation mark
        ctx.fillStyle = warningColor
        ctx.beginPath()
        ctx.arc(warningX, warningY - 2, 1.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillRect(warningX - 1, warningY + 1, 2, 3)
      }
    })

    // Draw market at its actual location
        if (marketPosition && market) {
          // Scale market position to actual canvas dimensions
          const baseMarketPos = marketPosition
          const x = axisLabelWidth + padding + (baseMarketPos.x - axisLabelWidth - padding) * scaleX
          const y = baseMarketPos.y * scaleY
      
      // Market icon (building shape)
      ctx.fillStyle = '#8b5cf6'
      ctx.beginPath()
      ctx.moveTo(x, y - 20)
      ctx.lineTo(x + 15, y + 10)
      ctx.lineTo(x - 15, y + 10)
      ctx.closePath()
      ctx.fill()
      ctx.fillRect(x - 10, y + 10, 20, 8)
      
      // Market glow
      ctx.shadowColor = '#8b5cf6'
      ctx.shadowBlur = 15
      ctx.beginPath()
      ctx.arc(x, y, 25, 0, Math.PI * 2)
      ctx.fillStyle = '#8b5cf6' + '20'
      ctx.fill()
      ctx.shadowBlur = 0
      
      // Market label
      ctx.fillStyle = '#8b5cf6'
      ctx.font = 'bold 12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(market.name || 'Market', x, y - 30)
    }
      }, [cauldrons, network, couriers, hoveredCauldron, selectedCauldron, currentTime, currentLevels, cauldronPositions, courierPositions, marketPosition, market, axisInfo, alerts, routes, cauldronRiskLevels])


  const hoveredCauldronData = cauldrons.find((c) => c.id === hoveredCauldron)

      return (
        <div className="relative w-full">
          <canvas
            ref={canvasRef}
            className="w-full h-[600px] border border-border rounded-lg bg-background/50 cursor-pointer"
            style={{ width: '100%', height: '600px' }}
            onMouseMove={handleMouseMove}
            onClick={handleClick}
          />
      {hoveredCauldron !== null && hoveredCauldron !== null && hoveredCauldronData && (
        <div className="absolute top-2 left-2 pointer-events-none z-10">
          <Badge variant="secondary" className="text-sm">
            {hoveredCauldronData.name || hoveredCauldronData.id}
          </Badge>
        </div>
      )}
    </div>
  )
}

