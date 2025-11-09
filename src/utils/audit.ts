import type { HistoricalDataDto, TicketDto, CauldronDto } from '../types/api'

export interface DrainEvent {
  cauldronId: string
  timestamp: Date
  actualDrainVolume: number
  fillRate: number
  levelBefore: number
  levelAfter: number
}

export interface Discrepancy {
  date: string
  ticketId: string | null
  type: 'unlogged_drain' | 'over_reported_sales'
  expectedVolume: number
  reportedVolume: number
  difference: number
  severity: 'low' | 'medium' | 'high'
}

/**
 * Calculate fill rate for a cauldron based on historical data
 * Uses linear regression on periods without drains
 */
export function calculateFillRate(
  cauldronId: string,
  historicalData: HistoricalDataDto[],
  _maxVolume: number
): number {
  if (historicalData.length < 2) return 0

  const cauldronKey = `cauldron_${cauldronId.split('_').pop()?.padStart(3, '0') || '001'}`
  const levels: number[] = []
  const times: number[] = []

  // Collect data points
  for (let i = 0; i < historicalData.length; i++) {
    const level = (historicalData[i].cauldron_levels as any)[cauldronKey]
    if (level !== undefined) {
      levels.push(level)
      times.push(new Date(historicalData[i].timestamp).getTime())
    }
  }

  if (levels.length < 2) return 0

  // Detect drains (sudden decreases) and calculate fill rate from increasing segments
  let totalFillRate = 0
  let fillRateCount = 0

  for (let i = 1; i < levels.length; i++) {
    const timeDiff = (times[i] - times[i - 1]) / (1000 * 60) // minutes
    const levelDiff = levels[i] - levels[i - 1]

    // If level increased (filling), calculate rate
    if (levelDiff > 0 && timeDiff > 0) {
      const rate = levelDiff / timeDiff // volume per minute
      totalFillRate += rate
      fillRateCount++
    }
  }

  return fillRateCount > 0 ? totalFillRate / fillRateCount : 0
}

/**
 * Detect drain events from historical data
 */
export function detectDrainEvents(
  cauldrons: CauldronDto[],
  historicalData: HistoricalDataDto[],
  fillRates: Map<string, number>
): DrainEvent[] {
  const drainEvents: DrainEvent[] = []

  if (historicalData.length < 2) return drainEvents

  for (const cauldron of cauldrons) {
    if (!cauldron.id) continue

    const cauldronKey = `cauldron_${cauldron.id.split('_').pop()?.padStart(3, '0') || '001'}`
    const fillRate = fillRates.get(cauldron.id) || 0

    for (let i = 1; i < historicalData.length; i++) {
      const prevData = historicalData[i - 1]
      const currData = historicalData[i]

      const prevLevel = (prevData.cauldron_levels as any)[cauldronKey] || 0
      const currLevel = (currData.cauldron_levels as any)[cauldronKey] || 0

      const prevTime = new Date(prevData.timestamp).getTime()
      const currTime = new Date(currData.timestamp).getTime()
      const timeDiff = (currTime - prevTime) / (1000 * 60) // minutes

      // Detect drain: level decreased significantly
      const expectedFill = fillRate * timeDiff
      const actualChange = prevLevel - currLevel

      // If actual decrease is more than expected (accounting for fill), it's a drain
      if (actualChange > expectedFill + 0.1) {
        // Calculate actual drain volume accounting for fill during drain
        const actualDrainVolume = actualChange + expectedFill

        drainEvents.push({
          cauldronId: cauldron.id,
          timestamp: new Date(currData.timestamp),
          actualDrainVolume,
          fillRate,
          levelBefore: prevLevel,
          levelAfter: currLevel,
        })
      }
    }
  }

  return drainEvents
}

/**
 * Aggregate drain volumes by date
 */
export function aggregateDrainsByDate(drainEvents: DrainEvent[]): Map<string, number> {
  const dailyDrains = new Map<string, number>()

  for (const event of drainEvents) {
    const dateKey = event.timestamp.toISOString().split('T')[0] // YYYY-MM-DD
    const current = dailyDrains.get(dateKey) || 0
    dailyDrains.set(dateKey, current + event.actualDrainVolume)
  }

  return dailyDrains
}

/**
 * Match tickets with daily drain volumes and detect discrepancies
 */
export function detectDiscrepancies(
  tickets: TicketDto[],
  dailyDrains: Map<string, number>
): Discrepancy[] {
  const discrepancies: Discrepancy[] = []
  const dailyTickets = new Map<string, { tickets: TicketDto[], totalVolume: number }>()

  // Group tickets by date
  for (const ticket of tickets) {
    if (!ticket.date) continue

    const dateKey = new Date(ticket.date).toISOString().split('T')[0]
    const dayData = dailyTickets.get(dateKey) || { tickets: [], totalVolume: 0 }

    dayData.tickets.push(ticket)
    dayData.totalVolume += ticket.amount_collected
    dailyTickets.set(dateKey, dayData)
  }

  // Compare daily totals
  for (const [date, dayData] of dailyTickets.entries()) {
    const expectedVolume = dailyDrains.get(date) || 0
    const reportedVolume = dayData.totalVolume
    const difference = Math.abs(expectedVolume - reportedVolume)
    const percentDiff = expectedVolume > 0 ? (difference / expectedVolume) * 100 : 0

    if (difference > 0.1) {
      // Determine discrepancy type
      let type: 'unlogged_drain' | 'over_reported_sales'
      if (reportedVolume < expectedVolume) {
        type = 'unlogged_drain'
      } else {
        type = 'over_reported_sales'
      }

      // Determine severity
      let severity: 'low' | 'medium' | 'high'
      if (percentDiff < 5) {
        severity = 'low'
      } else if (percentDiff < 15) {
        severity = 'medium'
      } else {
        severity = 'high'
      }

      // Create discrepancy for each ticket on this day
      for (const ticket of dayData.tickets) {
        discrepancies.push({
          date,
          ticketId: ticket.ticket_id,
          type,
          expectedVolume,
          reportedVolume,
          difference,
          severity,
        })
      }
    }
  }

  // Also flag days with drains but no tickets
  for (const [date, drainVolume] of dailyDrains.entries()) {
    if (!dailyTickets.has(date) && drainVolume > 0.1) {
      discrepancies.push({
        date,
        ticketId: null,
        type: 'unlogged_drain',
        expectedVolume: drainVolume,
        reportedVolume: 0,
        difference: drainVolume,
        severity: 'high',
      })
    }
  }

  return discrepancies
}

/**
 * Main audit function that processes all data
 */
export function runAudit(
  cauldrons: CauldronDto[],
  historicalData: HistoricalDataDto[],
  tickets: TicketDto[]
): {
  drainEvents: DrainEvent[]
  discrepancies: Discrepancy[]
  fillRates: Map<string, number>
} {
  // Calculate fill rates for each cauldron
  const fillRates = new Map<string, number>()
  for (const cauldron of cauldrons) {
    if (cauldron.id) {
      const fillRate = calculateFillRate(cauldron.id, historicalData, cauldron.max_volume)
      fillRates.set(cauldron.id, fillRate)
    }
  }

  // Detect drain events
  const drainEvents = detectDrainEvents(cauldrons, historicalData, fillRates)

  // Aggregate by date
  const dailyDrains = aggregateDrainsByDate(drainEvents)

  // Detect discrepancies
  const discrepancies = detectDiscrepancies(tickets, dailyDrains)

  return {
    drainEvents,
    discrepancies,
    fillRates,
  }
}

