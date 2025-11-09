import type { CauldronDto, HistoricalDataDto, TicketDto, CourierDto, NetworkDto } from '../types/api'

export interface Alert {
  id: string
  type: 'drain' | 'discrepancy' | 'drift' | 'fill_rate' | 'overflow' | 'delay' | 'audit' | 'trend' | 
        'overreporting' | 'unlogged_drain' | 'false_ticket' | 'unlogged_event' | 'clogged_flow' | 
        'production_stop' | 'delivery_delay' | 'late_delivery' | 'merge_violation' | 'critical_level'
  severity: 'info' | 'warning' | 'critical'
  cauldronId: string | null
  cauldronName: string | null
  message: string
  timestamp: Date
  details?: Record<string, any>
}

export interface DrainEvent {
  cauldronId: string
  timestamp: Date
  levelBefore: number
  levelAfter: number
  expectedDrainVolume: number
  duration: number // minutes
  refillRate?: number // L/min after drain
  isActive: boolean // true if drain is ongoing
}

export interface MonitoringState {
  fillRates: Map<string, number> // cauldron_id -> fill_rate (L/min)
  baselineFillRates: Map<string, number> // cauldron_id -> baseline_rate
  lastLevels: Map<string, number> // cauldron_id -> last_level
  drainEvents: DrainEvent[] // Active and completed drain events
  dailyDrains: Map<string, Map<string, number>> // cauldron_id -> date -> total_drain
  dailyTickets: Map<string, Map<string, TicketDto[]>> // cauldron_id -> date -> tickets[]
  discrepancyCounts: Map<string, number> // cauldron_id -> count of discrepancies in last 3 days
  overflowForecasts: Map<string, number | null> // cauldron_id -> minutes_to_overflow
  activeDrains: Map<string, DrainEvent> // cauldron_id -> active drain event
  lastStableTime: Map<string, Date> // cauldron_id -> last time level was stable
  courierPositions: Map<string, { lastTicketTime: Date | null; expectedArrival: Date | null }> // courier_id -> position info
  acknowledgedAlerts: Set<string> // Set of alert IDs that have been acknowledged
  criticalLevelAlerts: Set<string> // Set of cauldron IDs that have already triggered critical level alert
}

const TOLERANCE = 2.0 // liters tolerance for discrepancy matching
const DRAIN_STABILIZATION_TIME = 5 // minutes without drop to consider drain ended
const PRODUCTION_STOP_THRESHOLD = 0.1 // L/min - below this is considered stopped
const PRODUCTION_STOP_DURATION = 30 // minutes - duration to flag as production stop

/**
 * 1. Precompute Core Metrics
 * Calculate fill rate from positive slopes
 */
export function calculateFillRate(
  cauldronId: string,
  historicalData: HistoricalDataDto[],
  lookbackMinutes: number = 60
): number {
  if (historicalData.length < 2) return 0

  const cauldronKey = `cauldron_${cauldronId.split('_').pop()?.padStart(3, '0') || '001'}`
  const currentTime = new Date(historicalData[historicalData.length - 1].timestamp).getTime()
  const cutoffTime = currentTime - (lookbackMinutes * 60 * 1000)

  const positiveSlopes: number[] = []

  for (let i = 1; i < historicalData.length; i++) {
    const prevData = historicalData[i - 1]
    const currData = historicalData[i]

    const dataTime = new Date(currData.timestamp).getTime()
    if (dataTime < cutoffTime) continue

    const prevLevel = (prevData.cauldron_levels as any)[cauldronKey] || 0
    const currLevel = (currData.cauldron_levels as any)[cauldronKey] || 0
    const timeDiff = (dataTime - new Date(prevData.timestamp).getTime()) / (1000 * 60) // minutes

    if (timeDiff > 0 && currLevel > prevLevel) {
      const slope = (currLevel - prevLevel) / timeDiff
      positiveSlopes.push(slope)
    }
  }

  if (positiveSlopes.length === 0) return 0

  // Use median for robustness
  positiveSlopes.sort((a, b) => a - b)
  const mid = Math.floor(positiveSlopes.length / 2)
  return positiveSlopes.length % 2 === 0
    ? (positiveSlopes[mid - 1] + positiveSlopes[mid]) / 2
    : positiveSlopes[mid]
}

/**
 * Calculate expected drain volume accounting for continuous filling
 */
export function calculateExpectedDrainVolume(
  levelBefore: number,
  levelAfter: number,
  fillRate: number,
  durationMinutes: number
): number {
  const levelDrop = levelBefore - levelAfter
  const fillDuringDrain = fillRate * durationMinutes
  return levelDrop + fillDuringDrain
}

/**
 * Rule A: Drain Detection
 * Detect drain start and track until stabilization
 */
export function detectDrainStart(
  cauldron: CauldronDto,
  previousLevel: number,
  currentLevel: number
): boolean {
  if (!cauldron.id || !cauldron.max_volume) return false
  const drop = previousLevel - currentLevel
  const threshold = 0.05 * cauldron.max_volume
  return drop > threshold && drop > 0
}

/**
 * Match ticket to drain event by cauldron_id and date
 */
function matchTicketToDrain(
  drainEvent: DrainEvent,
  tickets: TicketDto[]
): TicketDto | null {
  const drainDate = drainEvent.timestamp.toISOString().split('T')[0]
  const drainTime = drainEvent.timestamp.getTime()

  // Find tickets for this cauldron on the same date, within 2 hours of drain
  const matchingTickets = tickets.filter(t => {
    if (!t.date || t.cauldron_id !== drainEvent.cauldronId) return false
    const ticketDate = new Date(t.date).toISOString().split('T')[0]
    if (ticketDate !== drainDate) return false

    const ticketTime = new Date(t.date).getTime()
    const timeDiff = Math.abs(ticketTime - drainTime)
    return timeDiff <= 2 * 60 * 60 * 1000 // 2 hours
  })

  if (matchingTickets.length === 0) return null

  // Return the ticket closest in time
  matchingTickets.sort((a, b) => {
    const timeA = Math.abs(new Date(a.date!).getTime() - drainTime)
    const timeB = Math.abs(new Date(b.date!).getTime() - drainTime)
    return timeA - timeB
  })

  return matchingTickets[0]
}

/**
 * 3. Discrepancy Assessment Rules
 */
export function assessDiscrepancy(
  drainEvent: DrainEvent,
  ticket: TicketDto | null,
  tolerance: number = TOLERANCE
): { type: string; severity: 'warning' | 'critical'; reason: string; action: string } | null {
  const expected = drainEvent.expectedDrainVolume

  // Case D: Drain Detected but No Ticket
  if (!ticket) {
    return {
      type: 'unlogged_event',
      severity: 'critical',
      reason: 'Potion was drained but no ticket was found for this event. Possible causes: Lost ticket, unauthorized pickup, or system error.',
      action: 'Action: Investigate immediately. Review security logs, check for unauthorized access, verify courier assignments, and recover missing ticket data if possible.'
    }
  }

  const reported = ticket.amount_collected || 0
  const diff = reported - expected

  // Case A: Overreporting
  if (diff > tolerance) {
    return {
      type: 'overreporting',
      severity: 'warning',
      reason: `Ticket reports ${diff.toFixed(2)}L more than actual drain. Possible causes: Market or logging exaggeration, data entry error, duplicate ticket, or measurement error.`,
      action: 'Action: Audit courier ID and frequency. Verify ticket accuracy, check for duplicate entries, review measurement equipment, and correct reporting system.'
    }
  }

  // Case B: Underreporting (Unlogged Drain)
  if (diff < -tolerance) {
    return {
      type: 'unlogged_drain',
      severity: 'critical',
      reason: `Actual drain exceeds ticket by ${Math.abs(diff).toFixed(2)}L. Possible causes: Unrecorded pickup, missing ticket entry, or unauthorized collection.`,
      action: 'Action: Review ticket logs, verify collection records, check for missing entries, and investigate unauthorized access.'
    }
  }

  return null // No discrepancy
}

/**
 * Case C: No Drain but Ticket Exists
 */
export function checkFalseTicket(
  _cauldronId: string,
  ticket: TicketDto,
  recentDrains: DrainEvent[]
): boolean {
  const ticketTime = new Date(ticket.date!).getTime()
  const ticketDate = ticket.date ? new Date(ticket.date).toISOString().split('T')[0] : null

  // Check if there's a drain event within 2 hours of ticket
  const hasMatchingDrain = recentDrains.some(drain => {
    const drainTime = drain.timestamp.getTime()
    const drainDate = drain.timestamp.toISOString().split('T')[0]
    const timeDiff = Math.abs(ticketTime - drainTime)
    return drainDate === ticketDate && timeDiff <= 2 * 60 * 60 * 1000
  })

  return !hasMatchingDrain
}

/**
 * Case E: Abnormal Fill Recovery (Clogged Flow)
 */
export function detectCloggedFlow(
  drainEvent: DrainEvent,
  baselineFillRate: number
): boolean {
  if (!drainEvent.refillRate || baselineFillRate === 0) return false
  return drainEvent.refillRate < 0.5 * baselineFillRate
}

/**
 * Case F: Expected Refill Too Slow
 */
export function checkSlowRefill(
  drainEvent: DrainEvent,
  baselineFillRate: number,
  expectedRefillTime: number // minutes
): boolean {
  if (!drainEvent.refillRate || baselineFillRate === 0) return false
  const actualRefillTime = (drainEvent.levelAfter - drainEvent.levelBefore + drainEvent.expectedDrainVolume) / drainEvent.refillRate
  return actualRefillTime > expectedRefillTime * 1.5 // 50% slower than expected
}

/**
 * Case G: Production Stop
 */
export function detectProductionStop(
  _cauldronId: string,
  currentLevel: number,
  previousLevel: number,
  timeDiff: number,
  fillRate: number,
  lastStableTime: Date | null,
  currentTimestamp: Date
): { isStopped: boolean; duration: number } {
  const levelChange = currentLevel - previousLevel
  const currentRate = timeDiff > 0 ? levelChange / timeDiff : 0

  if (currentRate < PRODUCTION_STOP_THRESHOLD && fillRate > 0) {
    // Level not increasing - check duration
    const stableTime = lastStableTime || currentTimestamp
    const duration = (currentTimestamp.getTime() - stableTime.getTime()) / (1000 * 60) // minutes
    return {
      isStopped: duration > PRODUCTION_STOP_DURATION,
      duration
    }
  }

  return { isStopped: false, duration: 0 }
}

/**
 * Case H: Total Daily Discrepancy
 */
export function checkDailyDiscrepancy(
  totalExpected: number,
  totalTicketed: number,
  threshold: number = 5 // 5%
): { exceedsThreshold: boolean; discrepancyPercent: number } {
  if (totalExpected === 0) return { exceedsThreshold: false, discrepancyPercent: 0 }
  const discrepancyPercent = (Math.abs(totalExpected - totalTicketed) / totalExpected) * 100
  return {
    exceedsThreshold: discrepancyPercent > threshold,
    discrepancyPercent
  }
}

/**
 * 4. Delivery Integrity Rules
 */
export function checkDeliveryDelay(
  _courier: CourierDto,
  ticket: TicketDto,
  network: NetworkDto | null,
  currentTimestamp: Date
): { isDelayed: boolean; delayMinutes: number } | null {
  if (!network?.edges || !ticket.date || !ticket.cauldron_id) return null

  const ticketTime = new Date(ticket.date).getTime()
  const timeSinceTicket = (currentTimestamp.getTime() - ticketTime) / (1000 * 60) // minutes

  // Find edge from cauldron to destination (market or another cauldron)
  const edge = network.edges.find(e => e.from === ticket.cauldron_id)
  if (!edge || !edge.travel_time_minutes) return null

  const expectedTravelTime = edge.travel_time_minutes
  const delayThreshold = expectedTravelTime * 1.3 // 30% over expected

  if (timeSinceTicket > delayThreshold) {
    return {
      isDelayed: true,
      delayMinutes: timeSinceTicket - expectedTravelTime
    }
  }

  return { isDelayed: false, delayMinutes: 0 }
}

/**
 * Main real-time monitoring function
 */
export function monitorRealTime(
  cauldrons: CauldronDto[],
  historicalData: HistoricalDataDto[],
  tickets: TicketDto[],
  currentTimestamp: Date,
  state: MonitoringState,
  couriers?: CourierDto[],
  network?: NetworkDto | null
): { alerts: Alert[]; updatedState: MonitoringState } {
  const alerts: Alert[] = []
  const currentTime = currentTimestamp.getTime()

  // Create a copy of state to update
  const updatedState: MonitoringState = {
    fillRates: new Map(state.fillRates),
    baselineFillRates: new Map(state.baselineFillRates),
    lastLevels: new Map(state.lastLevels),
    drainEvents: [...state.drainEvents],
    dailyDrains: new Map(
      Array.from(state.dailyDrains.entries()).map(([id, map]) => [id, new Map(map)])
    ),
    dailyTickets: new Map(
      Array.from(state.dailyTickets.entries()).map(([id, map]) => [
        id,
        new Map(Array.from(map.entries()).map(([date, tickets]) => [date, [...tickets]]))
      ])
    ),
    discrepancyCounts: new Map(state.discrepancyCounts),
    overflowForecasts: new Map(state.overflowForecasts),
    activeDrains: new Map(state.activeDrains),
    lastStableTime: new Map(state.lastStableTime),
    courierPositions: new Map(state.courierPositions),
    acknowledgedAlerts: new Set(state.acknowledgedAlerts),
    criticalLevelAlerts: new Set(state.criticalLevelAlerts)
  }

  // Get current levels from historical data
  let currentDataPoint: HistoricalDataDto | null = null
  let minDiff = Infinity

  for (const data of historicalData) {
    const dataTime = new Date(data.timestamp).getTime()
    const diff = Math.abs(dataTime - currentTime)
    if (diff < minDiff) {
      minDiff = diff
      currentDataPoint = data
    }
  }

  if (!currentDataPoint) return { alerts, updatedState }

  const currentLevels = currentDataPoint.cauldron_levels
  const dateKey = currentTimestamp.toISOString().split('T')[0]

  // Process each cauldron
  cauldrons.forEach(cauldron => {
    if (!cauldron.id || !cauldron.max_volume) return

    const levelKey = `cauldron_${cauldron.id.split('_').pop()?.padStart(3, '0') || '001'}`
    const currentLevel = (currentLevels as any)[levelKey] || 0
    const previousLevel = state.lastLevels.get(cauldron.id) || currentLevel

    // Update fill rate from historical data
    const fillRate = calculateFillRate(cauldron.id, historicalData, 60)
    const baselineFillRate = updatedState.baselineFillRates.get(cauldron.id) || fillRate
    if (!updatedState.baselineFillRates.has(cauldron.id) && fillRate > 0) {
      updatedState.baselineFillRates.set(cauldron.id, fillRate)
    }
    updatedState.fillRates.set(cauldron.id, fillRate)

    // Rule A: Drain Detection
    const activeDrain = updatedState.activeDrains.get(cauldron.id)
    const timeDiff = 1 // 1 minute intervals

    if (detectDrainStart(cauldron, previousLevel, currentLevel)) {
      // New drain detected or continue existing
      if (!activeDrain) {
        // Start new drain
        const newDrain: DrainEvent = {
          cauldronId: cauldron.id,
          timestamp: currentTimestamp,
          levelBefore: previousLevel,
          levelAfter: currentLevel,
          expectedDrainVolume: calculateExpectedDrainVolume(previousLevel, currentLevel, fillRate, timeDiff),
          duration: timeDiff,
          isActive: true
        }
        updatedState.activeDrains.set(cauldron.id, newDrain)
        updatedState.drainEvents.push(newDrain)
      } else {
        // Continue existing drain
        activeDrain.levelAfter = currentLevel
        activeDrain.duration += timeDiff
        activeDrain.expectedDrainVolume = calculateExpectedDrainVolume(
          activeDrain.levelBefore,
          activeDrain.levelAfter,
          fillRate,
          activeDrain.duration
        )
      }
    } else if (activeDrain) {
      // Check if drain has stabilized
      const timeSinceLastDrop = (currentTime - activeDrain.timestamp.getTime()) / (1000 * 60)
      if (timeSinceLastDrop >= DRAIN_STABILIZATION_TIME) {
        // Drain ended - calculate refill rate
        const refillRate = currentLevel > activeDrain.levelAfter
          ? (currentLevel - activeDrain.levelAfter) / timeSinceLastDrop
          : 0

        activeDrain.refillRate = refillRate
        activeDrain.isActive = false

        // Assess discrepancy
        const matchedTicket = matchTicketToDrain(activeDrain, tickets)
        const discrepancy = assessDiscrepancy(activeDrain, matchedTicket, TOLERANCE)

        if (discrepancy) {
          const count = updatedState.discrepancyCounts.get(cauldron.id) || 0
          updatedState.discrepancyCounts.set(cauldron.id, count + 1)

          alerts.push({
            id: `${discrepancy.type}-${cauldron.id}-${currentTime}`,
            type: discrepancy.type as any,
            severity: discrepancy.severity,
            cauldronId: cauldron.id,
            cauldronName: cauldron.name,
            message: `${discrepancy.type === 'overreporting' ? 'Overreporting detected' : 
                      discrepancy.type === 'unlogged_drain' ? 'Unlogged drain detected' : 
                      'Unlogged event detected'}: ${Math.abs(activeDrain.expectedDrainVolume - (matchedTicket?.amount_collected || 0)).toFixed(2)}L difference`,
            timestamp: currentTimestamp,
            details: {
              expectedDrainVolume: activeDrain.expectedDrainVolume,
              reportedVolume: matchedTicket?.amount_collected || 0,
              discrepancy: Math.abs(activeDrain.expectedDrainVolume - (matchedTicket?.amount_collected || 0)),
              reason: discrepancy.reason,
              action: discrepancy.action
            }
          })

          // Check for persistent drift
          if (count + 1 >= 2) {
            alerts.push({
              id: `drift-${cauldron.id}-${currentTime}`,
              type: 'drift',
              severity: 'critical',
              cauldronId: cauldron.id,
              cauldronName: cauldron.name,
              message: 'Persistent mismatch detected: 2+ discrepancies in last 3 days',
              timestamp: currentTimestamp,
              details: {
                discrepancyCount: count + 1,
                reason: 'Systematic reporting issue detected. Multiple discrepancies over consecutive days indicate a persistent problem with ticket logging or data collection.',
                action: 'Action: Investigate root cause immediately. Review ticket logging procedures, check for systemic errors in data collection, verify courier compliance, and implement corrective measures.'
              }
            })
          }
        }

        // Case E: Clogged Flow
        if (detectCloggedFlow(activeDrain, baselineFillRate)) {
          alerts.push({
            id: `clogged-flow-${cauldron.id}-${currentTime}`,
            type: 'clogged_flow',
            severity: 'warning',
            cauldronId: cauldron.id,
            cauldronName: cauldron.name,
            message: `Clogged flow detected: Refill rate ${activeDrain.refillRate?.toFixed(2)}L/min is below 50% of baseline`,
            timestamp: currentTimestamp,
            details: {
              refillRate: activeDrain.refillRate,
              baselineFillRate,
              reason: 'After drain, fill rate is significantly lower than baseline. Possible causes: Clogged cauldron, partial blockage, or brewing slowdown.',
              action: 'Action: Inspect cauldron for blockages, check brewing equipment, verify flow valves, and perform maintenance if needed.'
            }
          })
        }

        // Update daily drains
        const dailyDrainsMap = updatedState.dailyDrains.get(cauldron.id) || new Map()
        const currentDailyTotal = dailyDrainsMap.get(dateKey) || 0
        dailyDrainsMap.set(dateKey, currentDailyTotal + activeDrain.expectedDrainVolume)
        updatedState.dailyDrains.set(cauldron.id, dailyDrainsMap)

        // Store ticket if matched
        if (matchedTicket) {
          const dailyTicketsMap = updatedState.dailyTickets.get(cauldron.id) || new Map()
          const dayTickets = dailyTicketsMap.get(dateKey) || []
          if (!dayTickets.find((t: TicketDto) => t.ticket_id === matchedTicket.ticket_id)) {
            dayTickets.push(matchedTicket)
            dailyTicketsMap.set(dateKey, dayTickets)
            updatedState.dailyTickets.set(cauldron.id, dailyTicketsMap)
          }
        }

        updatedState.activeDrains.delete(cauldron.id)
      }
    }

    // Case C: Check for false tickets (tickets without matching drains)
    const cauldronTickets = tickets.filter(t => t.cauldron_id === cauldron.id && t.date)
    const recentDrains = updatedState.drainEvents.filter(
      d => d.cauldronId === cauldron.id && !d.isActive
    )

    for (const ticket of cauldronTickets) {
      if (checkFalseTicket(cauldron.id, ticket, recentDrains)) {
        alerts.push({
          id: `false-ticket-${ticket.ticket_id}-${currentTime}`,
          type: 'false_ticket',
          severity: 'warning',
          cauldronId: cauldron.id,
          cauldronName: cauldron.name,
          message: `False ticket detected: Ticket exists but no matching drain event found`,
          timestamp: currentTimestamp,
          details: {
            ticketId: ticket.ticket_id,
            ticketAmount: ticket.amount_collected,
            reason: 'Ticket was logged but no corresponding drain event detected. Possible causes: Fake delivery, data entry error, or system malfunction.',
            action: 'Action: Verify ticket accuracy, check for data entry errors, review courier logs, and investigate potential fraud.'
          }
        })
      }
    }

    // Case G: Production Stop
    const productionStop = detectProductionStop(
      cauldron.id,
      currentLevel,
      previousLevel,
      timeDiff,
      fillRate,
      updatedState.lastStableTime.get(cauldron.id) || null,
      currentTimestamp
    )

    if (productionStop.isStopped) {
      alerts.push({
        id: `production-stop-${cauldron.id}-${currentTime}`,
        type: 'production_stop',
        severity: 'critical',
        cauldronId: cauldron.id,
        cauldronName: cauldron.name,
        message: `Production stopped: Level not increasing for ${Math.round(productionStop.duration)} minutes`,
        timestamp: currentTimestamp,
        details: {
          duration: productionStop.duration,
          currentLevel,
          reason: 'Cauldron level has not increased for an extended period. Possible causes: Stuck cauldron, production halt, equipment failure, or flow blockage.',
          action: 'Action: Inspect cauldron immediately, check for equipment failures, verify production systems, and restart brewing process if needed.'
        }
      })
    } else if (currentLevel > previousLevel) {
      // Reset stable time if level is increasing
      updatedState.lastStableTime.delete(cauldron.id)
    } else {
      // Update stable time if level not increasing
      if (!updatedState.lastStableTime.has(cauldron.id)) {
        updatedState.lastStableTime.set(cauldron.id, currentTimestamp)
      }
    }

    // Rule 6: Overflow Forecast
    // Only notify once, 10 minutes before overflow, and don't notify again once acknowledged
    const timeToOverflow = fillRate > 0
      ? (cauldron.max_volume - currentLevel) / fillRate
      : null

    if (timeToOverflow !== null) {
      updatedState.overflowForecasts.set(cauldron.id, timeToOverflow)
      
      // Only alert when time to overflow is between 9-11 minutes (10 minutes ± 1 minute window)
      // And only if this alert hasn't been acknowledged yet
      const alertId = `overflow-${cauldron.id}`
      const shouldAlert = timeToOverflow >= 9 && timeToOverflow <= 11 && 
                         !updatedState.acknowledgedAlerts.has(alertId) &&
                         timeToOverflow < 240

      if (shouldAlert) {
        alerts.push({
          id: alertId,
          type: 'overflow',
          severity: 'critical',
          cauldronId: cauldron.id,
          cauldronName: cauldron.name,
          message: `Overflow risk: ${Math.round(timeToOverflow)} minutes remaining`,
          timestamp: currentTimestamp,
          details: {
            timeToOverflow,
            currentLevel,
            maxVolume: cauldron.max_volume,
            reason: `Cauldron will overflow in ${Math.round(timeToOverflow)} minutes if not drained. Immediate action required.`,
            action: 'Action: Schedule immediate drain, dispatch courier, or reduce fill rate to prevent overflow.'
          }
        })
      }
    }

    // Critical Level Alert: Detect when cauldron reaches critical level (>80% of max volume)
    const percentage = (currentLevel / cauldron.max_volume) * 100
    const previousPercentage = ((previousLevel / cauldron.max_volume) * 100)
    const criticalThreshold = 80

    // Only alert when crossing the threshold (entering critical zone), not continuously
    if (percentage > criticalThreshold && previousPercentage <= criticalThreshold) {
      const alertId = `critical-level-${cauldron.id}`
      
      // Only alert if not already acknowledged and not already alerted for this cauldron
      if (!updatedState.acknowledgedAlerts.has(alertId) && 
          !updatedState.criticalLevelAlerts.has(cauldron.id)) {
        updatedState.criticalLevelAlerts.add(cauldron.id)
        
        alerts.push({
          id: alertId,
          type: 'critical_level',
          severity: 'critical',
          cauldronId: cauldron.id,
          cauldronName: cauldron.name,
          message: `Critical level reached: ${percentage.toFixed(1)}% full (${currentLevel.toFixed(2)}L / ${cauldron.max_volume}L)`,
          timestamp: currentTimestamp,
          details: {
            currentLevel,
            maxVolume: cauldron.max_volume,
            percentage: percentage.toFixed(1),
            reason: `Cauldron has reached critical level (${percentage.toFixed(1)}% full). Immediate drain required to prevent overflow.`,
            action: 'Action: Schedule immediate drain, dispatch courier urgently, or reduce fill rate immediately to prevent overflow.'
          }
        })
      }
    } else if (percentage <= criticalThreshold && previousPercentage > criticalThreshold) {
      // Reset alert flag when level drops below critical threshold
      updatedState.criticalLevelAlerts.delete(cauldron.id)
    }

    // Update last level
    updatedState.lastLevels.set(cauldron.id, currentLevel)
  })

  // Case H: Daily Discrepancy Summary
  const currentHour = currentTimestamp.getHours()
  const currentMinute = currentTimestamp.getMinutes()
  if (currentHour === 23 && currentMinute >= 55) {
    let totalExpected = 0
    let totalTicketed = 0

    cauldrons.forEach(cauldron => {
      if (!cauldron.id) return
      const dailyDrainsMap = updatedState.dailyDrains.get(cauldron.id) || new Map()
      const dailyTicketsMap = updatedState.dailyTickets.get(cauldron.id) || new Map()
      totalExpected += dailyDrainsMap.get(dateKey) || 0
      totalTicketed += (dailyTicketsMap.get(dateKey) || []).reduce(
        (sum: number, t: TicketDto) => sum + (t.amount_collected || 0),
        0
      )
    })

    const dailyCheck = checkDailyDiscrepancy(totalExpected, totalTicketed, 5)
    if (dailyCheck.exceedsThreshold) {
      alerts.push({
        id: `daily-audit-${currentTime}`,
        type: 'audit',
        severity: 'warning',
        cauldronId: null,
        cauldronName: null,
        message: `Daily audit: ${dailyCheck.discrepancyPercent.toFixed(2)}% discrepancy exceeds 5% threshold`,
        timestamp: currentTimestamp,
        details: {
          totalExpected,
          totalTicketed,
          discrepancyPercent: dailyCheck.discrepancyPercent,
          reason: `Total daily discrepancy of ${dailyCheck.discrepancyPercent.toFixed(2)}% exceeds acceptable threshold. System-wide issue detected.`,
          action: 'Action: Review all cauldron operations, audit ticket logging system, verify courier compliance, and investigate systemic errors.'
        }
      })
    }
  }

  // Delivery Integrity Rules (if couriers and network provided)
  if (couriers && network) {
    couriers.forEach(courier => {
      if (!courier.courier_id) return

      const courierTickets = tickets.filter(t => t.courier_id === courier.courier_id && t.date)
      for (const ticket of courierTickets) {
        const delayCheck = checkDeliveryDelay(courier, ticket, network, currentTimestamp)
        if (delayCheck?.isDelayed) {
          alerts.push({
            id: `delivery-delay-${courier.courier_id}-${currentTime}`,
            type: 'delivery_delay',
            severity: 'warning',
            cauldronId: ticket.cauldron_id || null,
            cauldronName: null,
            message: `Courier delay: ${Math.round(delayCheck.delayMinutes)} minutes overdue`,
            timestamp: currentTimestamp,
            details: {
              courierId: courier.courier_id,
              delayMinutes: delayCheck.delayMinutes,
              reason: 'Courier travel time exceeds expected route time by 30%+. Possible causes: Courier delay, detour, traffic, or route deviation.',
              action: 'Action: Contact courier, verify route status, check for obstacles, and update expected arrival time.'
            }
          })
        }
      }
    })
  }

  return { alerts, updatedState }
}

/**
 * Initialize monitoring state
 */
export function initializeMonitoringState(): MonitoringState {
  return {
    fillRates: new Map(),
    baselineFillRates: new Map(),
    lastLevels: new Map(),
    drainEvents: [],
    dailyDrains: new Map(),
    dailyTickets: new Map(),
    discrepancyCounts: new Map(),
    overflowForecasts: new Map(),
    activeDrains: new Map(),
    lastStableTime: new Map(),
    courierPositions: new Map(),
    acknowledgedAlerts: new Set(),
    criticalLevelAlerts: new Set()
  }
}

/**
 * Acknowledge an alert (mark it as acknowledged so it won't be shown again)
 */
export function acknowledgeAlert(
  state: MonitoringState,
  alertId: string
): MonitoringState {
  const updatedState: MonitoringState = {
    ...state,
    acknowledgedAlerts: new Set(state.acknowledgedAlerts)
  }
  updatedState.acknowledgedAlerts.add(alertId)
  return updatedState
}
