import { useState, useMemo } from 'react'
import { Card } from './ui/card'
import { Badge } from './ui/badge'
import { ScrollArea } from './ui/scroll-area'
import { CheckCircle2, ChevronRight, AlertTriangle, User } from 'lucide-react'
import type { Discrepancy, DrainEvent } from '../utils/audit'
import type { TicketDto, CauldronDto, CourierDto } from '../types/api'

interface AuditLogProps {
  discrepancies: Discrepancy[]
  drainEvents: DrainEvent[]
  tickets?: TicketDto[]
  cauldrons?: CauldronDto[]
  couriers?: CourierDto[]
  currentTimestamp?: Date | null
}

interface CauldronIssue {
  cauldronId: string
  cauldronName: string
  discrepancies: Discrepancy[]
  highestSeverity: 'low' | 'medium' | 'high'
  affectedTickets: TicketDto[]
  affectedDates: Set<string>
}

export default function AuditLog({ discrepancies, drainEvents, tickets = [], cauldrons = [], couriers = [], currentTimestamp }: AuditLogProps) {
  const [selectedCauldronId, setSelectedCauldronId] = useState<string | null>(null)

  // Filter discrepancies and drain events visible at current timestamp (updates as data flows in)
  const visibleDiscrepancies = currentTimestamp
    ? discrepancies.filter(d => {
        const discDate = new Date(d.date)
        return discDate <= currentTimestamp
      })
    : discrepancies

  const visibleDrains = currentTimestamp
    ? drainEvents.filter(e => e.timestamp <= currentTimestamp)
    : drainEvents

  // Create a map of ticket IDs to tickets for quick lookup
  const ticketMap = useMemo(() => {
    const map = new Map<string, TicketDto>()
    tickets.forEach(ticket => {
      if (ticket.ticket_id) {
        map.set(ticket.ticket_id, ticket)
      }
    })
    return map
  }, [tickets])

  // Create a map of cauldron IDs to cauldron names
  const cauldronMap = useMemo(() => {
    const map = new Map<string, string>()
    cauldrons.forEach(cauldron => {
      if (cauldron.id) {
        map.set(cauldron.id, cauldron.name || cauldron.id)
      }
    })
    return map
  }, [cauldrons])

  // Group discrepancies by cauldron
  const cauldronIssues = useMemo(() => {
    const issuesMap = new Map<string, CauldronIssue>()

    visibleDiscrepancies.forEach(disc => {
      // Get cauldron ID from ticket
      let cauldronId: string | null = null
      if (disc.ticketId) {
        const ticket = ticketMap.get(disc.ticketId)
        cauldronId = ticket?.cauldron_id || null
      }

      // If no cauldron ID from ticket, try to get from drain events for this date
      if (!cauldronId) {
        const dateDrains = visibleDrains.filter(d => {
          const drainDate = d.timestamp.toISOString().split('T')[0]
          return drainDate === disc.date
        })
        if (dateDrains.length > 0) {
          // Use the first drain event's cauldron ID
          cauldronId = dateDrains[0].cauldronId
        }
      }

      // If still no cauldron ID, skip this discrepancy
      if (!cauldronId) return

      const existing = issuesMap.get(cauldronId)
      const cauldronName = cauldronMap.get(cauldronId) || cauldronId

      if (existing) {
        existing.discrepancies.push(disc)
        existing.affectedDates.add(disc.date)
        if (disc.ticketId) {
          const ticket = ticketMap.get(disc.ticketId)
          if (ticket && !existing.affectedTickets.some(t => t.ticket_id === ticket.ticket_id)) {
            existing.affectedTickets.push(ticket)
          }
        }
        // Update highest severity
        const severityOrder = { low: 1, medium: 2, high: 3 }
        if (severityOrder[disc.severity] > severityOrder[existing.highestSeverity]) {
          existing.highestSeverity = disc.severity
        }
      } else {
        const affectedTickets: TicketDto[] = []
        if (disc.ticketId) {
          const ticket = ticketMap.get(disc.ticketId)
          if (ticket) {
            affectedTickets.push(ticket)
          }
        }
        issuesMap.set(cauldronId, {
          cauldronId,
          cauldronName,
          discrepancies: [disc],
          highestSeverity: disc.severity,
          affectedTickets,
          affectedDates: new Set([disc.date]),
        })
      }
    })

    // Sort by severity (high first) then by cauldron name
    return Array.from(issuesMap.values()).sort((a, b) => {
      const severityOrder = { low: 1, medium: 2, high: 3 }
      const severityDiff = severityOrder[b.highestSeverity] - severityOrder[a.highestSeverity]
      if (severityDiff !== 0) return severityDiff
      return a.cauldronName.localeCompare(b.cauldronName)
    })
  }, [visibleDiscrepancies, ticketMap, cauldronMap, visibleDrains])

  const selectedIssue = selectedCauldronId
    ? cauldronIssues.find(issue => issue.cauldronId === selectedCauldronId)
    : null

  return (
    <Card className="p-6 border-border bg-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">Audit Report</h3>
        </div>
      </div>

      {cauldronIssues.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
          <p>No discrepancies detected</p>
        </div>
      ) : selectedIssue ? (
        // Show details for selected cauldron
        <ScrollArea className="h-[300px] pr-4">
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setSelectedCauldronId(null)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Back to Cauldrons
              </button>
            </div>

            <div className="space-y-3">
            <div className="p-4 border-2 rounded-lg bg-background/50">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="font-semibold text-lg">{selectedIssue.cauldronName}</h4>
              </div>
              <div className="text-sm text-muted-foreground">
                <div>Cauldron ID: {selectedIssue.cauldronId}</div>
                <div className="mt-1">
                  {selectedIssue.discrepancies.length} discrepancy{selectedIssue.discrepancies.length !== 1 ? 'ies' : ''} detected
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <h5 className="font-semibold text-sm">Problem Summary</h5>
              {Array.from(selectedIssue.affectedDates).sort((a, b) => {
                // Sort dates chronologically (oldest first)
                return new Date(a).getTime() - new Date(b).getTime()
              }).map(date => {
                const dateDiscrepancies = selectedIssue.discrepancies.filter(d => d.date === date)
                const dateTickets = selectedIssue.affectedTickets.filter(t => {
                  if (!t.date) return false
                  const ticketDate = new Date(t.date).toISOString().split('T')[0]
                  return ticketDate === date
                })
                
                const hasUnloggedDrain = dateDiscrepancies.some(d => d.type === 'unlogged_drain')
                const hasOverReported = dateDiscrepancies.some(d => d.type === 'over_reported_sales')
                
                return (
                  <div
                    key={date}
                    className="p-4 border-2 rounded-lg border-border bg-background/50"
                  >
                    <div className="flex items-start gap-2 mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-semibold text-sm">
                            {new Date(date).toLocaleDateString('en-US', { 
                              weekday: 'short', 
                              month: 'short', 
                              day: 'numeric' 
                            })}
                          </span>
                        </div>
                        
                        <div className="text-xs text-muted-foreground space-y-2">
                          <div>
                            <span className="font-medium">Problem: </span>
                            {hasUnloggedDrain && hasOverReported
                              ? 'Unlogged Drain & Over-Reported Sales'
                              : hasUnloggedDrain
                              ? 'Unlogged Drain Suspected - Potion was drained but not properly logged in tickets'
                              : 'Over-Reported Sales Suspected - Tickets report more volume than was actually drained'}
                          </div>
                          
                          {dateDiscrepancies.length > 0 && (
                            <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-border/50">
                              <div>
                                <span className="font-medium">Expected Volume:</span>{' '}
                                {dateDiscrepancies[0].expectedVolume.toFixed(2)}L
                              </div>
                              <div>
                                <span className="font-medium">Reported Volume:</span>{' '}
                                {dateDiscrepancies[0].reportedVolume.toFixed(2)}L
                              </div>
                              <div className="col-span-2">
                                <span className="font-medium">Difference:</span>{' '}
                                <span className="font-bold">
                                  {dateDiscrepancies[0].difference.toFixed(2)}L (
                                  {dateDiscrepancies[0].expectedVolume > 0
                                    ? ((dateDiscrepancies[0].difference / dateDiscrepancies[0].expectedVolume) * 100).toFixed(1)
                                    : '0'
                                  }%)
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {dateTickets.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-border/50">
                        <div className="text-xs font-semibold mb-2 text-muted-foreground">
                          Affected Tickets ({dateTickets.length}):
                        </div>
                        <div className="space-y-1">
                          {dateTickets.map(ticket => (
                            <div
                              key={ticket.ticket_id}
                              className="flex items-center justify-between p-2 bg-background/50 rounded text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <AlertTriangle className="h-3 w-3 text-yellow-500" />
                                <span className="font-mono">{ticket.ticket_id}</span>
                                {ticket.courier_id && (
                                  <Badge variant="outline" className="text-[10px]">
                                    {ticket.courier_id}
                                  </Badge>
                                )}
                              </div>
                              <span className="font-medium">{ticket.amount_collected.toFixed(2)}L</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        </ScrollArea>
      ) : (
        // Show list of cauldrons with issues
        <ScrollArea className="h-[300px] pr-4">
          <div className="space-y-2">
            {cauldronIssues.map((issue) => {
              // Extract cauldron number from ID (e.g., "cauldron_001" -> 1, "cauldron_002" -> 2)
              let number = 0
              const parts = issue.cauldronId.split('_')
              const lastPart = parts[parts.length - 1]
              // Try to extract number from last part (remove leading zeros)
              const numStr = lastPart?.replace(/^0+/, '') || lastPart || '0'
              number = parseInt(numStr, 10) || 0
              // If parsing failed, try parsing the whole ID
              if (number === 0) {
                number = parseInt(issue.cauldronId.replace(/\D/g, ''), 10) || 0
              }
              
              return (
              <button
                key={issue.cauldronId}
                onClick={() => setSelectedCauldronId(issue.cauldronId)}
                className="w-full p-3 border-2 rounded-lg border-border bg-background/50 text-left transition-all hover:bg-accent/50"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 font-semibold text-sm">
                      {number}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{issue.cauldronName}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {issue.discrepancies.length} issue{issue.discrepancies.length !== 1 ? 's' : ''} • {' '}
                        {issue.affectedDates.size} day{issue.affectedDates.size !== 1 ? 's' : ''} affected • {' '}
                        {issue.affectedTickets.length} ticket{issue.affectedTickets.length !== 1 ? 's' : ''} flagged
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </button>
              )
            })}
          </div>
        </ScrollArea>
      )}

      {/* Witches Section - Show flag counts per courier */}
      {couriers.length > 0 && (
        <div className="mt-6 pt-6 border-t border-border">
          <h4 className="text-sm font-semibold mb-4">
            Witches Flag Count
          </h4>
          <div className="grid grid-cols-5 gap-4">
            {couriers.slice(0, 5).map((courier) => {
              // Count flags (discrepancies) for this courier
              const courierTickets = tickets.filter(t => t.courier_id === courier.courier_id)
              const courierTicketIds = new Set(courierTickets.map(t => t.ticket_id).filter(Boolean))
              const flagCount = visibleDiscrepancies.filter(d => 
                d.ticketId && courierTicketIds.has(d.ticketId)
              ).length

              return (
                <div
                  key={courier.courier_id}
                  className="flex flex-col items-center p-3 border-2 rounded-lg border-border bg-background/50"
                >
                  <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center mb-2">
                    <User className="h-6 w-6 text-purple-400" />
                  </div>
                  <div className="text-xs font-semibold text-center mb-1">
                    {courier.name || courier.courier_id || 'Unknown'}
                  </div>
                  <div className="flex items-center gap-1">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm font-bold">{flagCount}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    flag{flagCount !== 1 ? 's' : ''}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Card>
  )
}

