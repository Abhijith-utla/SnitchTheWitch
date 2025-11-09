import { useState, useEffect, useMemo } from 'react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Slider } from './ui/slider'
import { RefreshCw, Route, Users, Clock, Package, TrendingDown, Map as MapIcon, Calendar } from 'lucide-react'
import { apiService } from '../services/api'
import NetworkMap from './NetworkMap'
import type { CauldronDto, HistoricalDataDto, NetworkDto, CourierDto, MarketDto, CauldronLevelsDto } from '../types/api'
import { calculateFillRate, predictTimeUntilOverflow, getCauldronKey } from './ForecastingTab'

// Note: Using Map and Set directly now (no shadowing issues)

interface OptimizationTabProps {
  cauldrons: CauldronDto[]
  historicalData?: HistoricalDataDto[]
  network?: NetworkDto | null
  couriers?: CourierDto[]
  market?: MarketDto | null
  dataStartTime?: number
  dataEndTime?: number
}

interface CauldronForecast {
  cauldronId: string
  cauldronName: string
  currentLevel: number
  maxVolume: number
  fillRate: number
  timeUntilOverflow: number
  riskLevel: 'low' | 'medium' | 'high'
  demand: number // Volume needed to prevent overflow
}

interface Route {
  courierId: string
  courierName: string
  stops: Array<{
    cauldronId: string
    cauldronName: string
    arrivalTime: number // minutes from now
    pickupVolume: number
  }>
  totalVolume: number
  totalTime: number // minutes
}

interface OptimizationResult {
  numCouriers: number
  routes: Route[]
  totalTime: number
}

export default function OptimizationTab({
  cauldrons,
  historicalData: initialHistoricalData,
  network,
  couriers = [],
  market,
  dataStartTime,
  dataEndTime
}: OptimizationTabProps) {
  const [historicalData, setHistoricalData] = useState<HistoricalDataDto[]>(initialHistoricalData || [])
  const [localMarket, setLocalMarket] = useState<MarketDto | null>(market || null)
  const [localNetwork, setLocalNetwork] = useState<NetworkDto | null>(network || null)
  const [localCouriers, setLocalCouriers] = useState<CourierDto[]>(couriers || [])
  const [loading, setLoading] = useState(!initialHistoricalData)
  const [optimizing, setOptimizing] = useState(false)
  const [selectedTimePoint, setSelectedTimePoint] = useState<number | null>(null) // Selected time point in milliseconds
  const [optimizationResult, setOptimizationResult] = useState<OptimizationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [naiveResult, setNaiveResult] = useState<OptimizationResult | null>(null) // For comparison

  // Fetch missing data if not provided
  useEffect(() => {
    const fetchMissingData = async () => {
      const promises: Promise<any>[] = []
      
      // Fetch historical data if not provided
      if (!initialHistoricalData && dataStartTime && dataEndTime) {
        const startTimestampSeconds = Math.floor(dataStartTime / 1000)
        const endTimestampSeconds = Math.floor(dataEndTime / 1000)
        promises.push(
          apiService.getHistoricalData(startTimestampSeconds, endTimestampSeconds)
            .then(data => setHistoricalData(data))
            .catch(err => console.error('Failed to fetch historical data:', err))
        )
      }
      
      // Fetch market if not provided
      if (!localMarket) {
        promises.push(
          apiService.getMarket()
            .then(data => setLocalMarket(data))
            .catch(err => console.error('Failed to fetch market:', err))
        )
      }
      
      // Fetch network if not provided
      if (!localNetwork) {
        promises.push(
          apiService.getNetwork()
            .then(data => setLocalNetwork(data))
            .catch(err => console.error('Failed to fetch network:', err))
        )
      }
      
      // Fetch couriers if not provided
      if (localCouriers.length === 0) {
        promises.push(
          apiService.getCouriers()
            .then(data => setLocalCouriers(data))
            .catch(err => console.error('Failed to fetch couriers:', err))
        )
      }
      
      if (promises.length > 0) {
        setLoading(true)
        await Promise.all(promises)
        setLoading(false)
      }
    }
    
    fetchMissingData()
  }, [initialHistoricalData, dataStartTime, dataEndTime, localMarket, localNetwork, localCouriers.length])

  // Calculate time span for timeline
  const timeSpan = useMemo(() => {
    if (!dataStartTime || !dataEndTime) return null
    return {
      start: dataStartTime,
      end: dataEndTime,
      totalMs: dataEndTime - dataStartTime
    }
  }, [dataStartTime, dataEndTime])

  // Initialize selected time point to end time (most recent)
  useEffect(() => {
    if (timeSpan && selectedTimePoint === null) {
      setSelectedTimePoint(timeSpan.end)
    }
  }, [timeSpan, selectedTimePoint])

  // Get historical data point at selected time (or interpolate)
  const getLevelAtTime = (cauldronKey: string, targetTime: number): number => {
    if (historicalData.length === 0) return 0
    
    // Find the closest data points
    let before: HistoricalDataDto | null = null
    let after: HistoricalDataDto | null = null
    
    for (let i = 0; i < historicalData.length; i++) {
      const dataPoint = historicalData[i]
      const dataTime = new Date(dataPoint.timestamp).getTime()
      
      if (dataTime <= targetTime) {
        before = dataPoint
      }
      if (dataTime >= targetTime && !after) {
        after = dataPoint
        break
      }
    }
    
    // If exact match or only one point, return that level
    if (before && (!after || before === after)) {
      return ((before.cauldron_levels as any)?.[cauldronKey] || 0)
    }
    
    // Interpolate between before and after
    if (before && after) {
      const beforeTime = new Date(before.timestamp).getTime()
      const afterTime = new Date(after.timestamp).getTime()
      const beforeLevel = ((before.cauldron_levels as any)?.[cauldronKey] || 0)
      const afterLevel = ((after.cauldron_levels as any)?.[cauldronKey] || 0)
      
      if (afterTime === beforeTime) return beforeLevel
      
      const ratio = (targetTime - beforeTime) / (afterTime - beforeTime)
      return beforeLevel + (afterLevel - beforeLevel) * ratio
    }
    
    // Fallback to last known level
    const lastDataPoint = historicalData[historicalData.length - 1]
    return lastDataPoint ? ((lastDataPoint.cauldron_levels as any)?.[cauldronKey] || 0) : 0
  }

  // Calculate forecasts for ALL cauldrons at the selected time point
  const allCauldronForecasts = useMemo(() => {
    if (historicalData.length === 0 || cauldrons.length === 0 || selectedTimePoint === null) return []

    const forecasts: CauldronForecast[] = []
    
    // Get historical data up to selected time point
    const filteredData = historicalData.filter(d => new Date(d.timestamp).getTime() <= selectedTimePoint)

    cauldrons.forEach(cauldron => {
      if (!cauldron.id) return

      const cauldronKey = getCauldronKey(cauldron.id)
      
      // Get level at selected time point
      const currentLevel = getLevelAtTime(cauldronKey, selectedTimePoint)
      
      // Calculate fill rate from historical data up to selected time
      const fillRate = calculateFillRate(filteredData, cauldronKey)
      
      // Predict time until overflow from selected time point
      const timeUntilOverflow = predictTimeUntilOverflow(
        currentLevel,
        cauldron.max_volume,
        fillRate
      )

      let riskLevel: 'low' | 'medium' | 'high'
      if (timeUntilOverflow < 4 * 60) {
        riskLevel = 'high'
      } else if (timeUntilOverflow < 8 * 60) {
        riskLevel = 'medium'
      } else {
        riskLevel = 'low'
      }

      // Calculate demand: target optimal level (75% of max) instead of full max
      // This allows witches to maintain safe levels without over-collecting
      // Witches can visit multiple cauldrons and partially fill from each to efficiently use their 100L capacity
      const optimalTarget = cauldron.max_volume * 0.75
      const demand = Math.max(0, optimalTarget - currentLevel)
      forecasts.push({
        cauldronId: cauldron.id,
        cauldronName: cauldron.name || cauldron.id,
        currentLevel,
        maxVolume: cauldron.max_volume,
        fillRate,
        timeUntilOverflow,
        riskLevel,
        demand
      })
    })

    return forecasts
  }, [historicalData, cauldrons, selectedTimePoint])

  // All cauldrons prioritized by urgency (high-risk first)
  const allCauldronsPrioritized = useMemo(() => {
    // Sort by: risk level (high > medium > low), then by time until overflow
    return [...allCauldronForecasts].sort((a, b) => {
      const riskPriority = { 'high': 3, 'medium': 2, 'low': 1 }
      const riskDiff = riskPriority[b.riskLevel] - riskPriority[a.riskLevel]
      if (riskDiff !== 0) return riskDiff
      return a.timeUntilOverflow - b.timeUntilOverflow
    })
  }, [allCauldronForecasts])

  // Get cauldrons to optimize (all cauldrons with demand)
  const cauldronsToOptimize = useMemo(() => {
    return allCauldronsPrioritized.filter(c => c.demand > 0)
  }, [allCauldronsPrioritized])

  // Risk level map for NetworkMap
  const cauldronRiskLevels = useMemo(() => {
    const riskMap = new Map<string, 'low' | 'medium' | 'high'>()
    allCauldronForecasts.forEach(forecast => {
      riskMap.set(forecast.cauldronId, forecast.riskLevel)
    })
    return riskMap
  }, [allCauldronForecasts])

  // Current cauldron levels for NetworkMap
  const currentLevels = useMemo(() => {
    if (historicalData.length === 0) return {}
    const lastDataPoint = historicalData[historicalData.length - 1]
    return lastDataPoint?.cauldron_levels || {}
  }, [historicalData])

  // Build distance matrix from network
  const distanceMatrix = useMemo(() => {
    const networkToUse = localNetwork || network
    if (!networkToUse?.edges) return new Map<string, Map<string, number>>()

    const matrix = new Map<string, Map<string, number>>()
    
    // Initialize matrix with all nodes
    const allNodes = new Set<string>()
    cauldrons.forEach(c => {
      if (c.id) allNodes.add(c.id)
    })
    const marketToUse = localMarket || market
    if (marketToUse?.id) allNodes.add(marketToUse.id)

    allNodes.forEach(node => {
      matrix.set(node, new Map<string, number>())
    })

    // Fill matrix from network edges
    networkToUse.edges.forEach(edge => {
      if (edge.from && edge.to && edge.travel_time_minutes) {
        const fromMap = matrix.get(edge.from)
        if (fromMap) {
          fromMap.set(edge.to, edge.travel_time_minutes)
        }
      }
    })

    return matrix
  }, [localNetwork, network, cauldrons, localMarket, market])

  // Calculate naive solution (one courier per cauldron) for comparison
  const calculateNaiveSolution = (cauldronsToService: CauldronForecast[]): OptimizationResult => {
    const routes: Route[] = []
    const couriersToUse = localCouriers.length > 0 ? localCouriers : couriers
    const marketToUse = localMarket || market
    
    cauldronsToService.forEach((cauldron, idx) => {
      if (idx < couriersToUse.length) {
        const courier = couriersToUse[idx]
        // Simple route: Market -> Cauldron -> Market
        const marketId = marketToUse?.id || 'market'
        const travelTime = distanceMatrix.get(marketId)?.get(cauldron.cauldronId) || 30
        const returnTime = distanceMatrix.get(cauldron.cauldronId)?.get(marketId) || 30
        
        routes.push({
          courierId: courier.courier_id || `courier_${idx}`,
          courierName: courier.name || `Courier ${idx + 1}`,
          stops: [{
            cauldronId: cauldron.cauldronId,
            cauldronName: cauldron.cauldronName,
            arrivalTime: travelTime, // Arrival time at cauldron
            pickupVolume: cauldron.demand
          }],
          totalVolume: cauldron.demand,
          totalTime: travelTime + 5 + returnTime + 15 // travel to cauldron + 5min pickup + return travel + 15min unload
        })
      }
    })

    return {
      numCouriers: routes.length,
      routes,
      totalTime: Math.max(...routes.map(r => r.totalTime), 0)
    }
  }

  // Solve VRP optimization
  const solveOptimization = async () => {
    if (selectedTimePoint === null) {
      setError('Please select a time point on the timeline')
      return
    }

    if (cauldronsToOptimize.length === 0) {
      setError('No cauldrons need service at the selected time point')
      return
    }

    const marketToUse = localMarket || market
    if (!marketToUse) {
      setError('Market information not available. Please wait for data to load or refresh the page.')
      return
    }

    const couriersToUse = localCouriers.length > 0 ? localCouriers : couriers
    if (couriersToUse.length === 0) {
      setError('No couriers available. Please wait for data to load or refresh the page.')
      return
    }

    setOptimizing(true)
    setError(null)

    try {
      // Calculate naive solution for comparison
      const naive = calculateNaiveSolution(cauldronsToOptimize)
      setNaiveResult(naive)

      // Call Python OR-Tools API for VRP solving
      // ALWAYS minimize number of witches (optimizeForTime=false)
      // The solver will find the minimum number of witches needed to prevent all overflows
      const result = await solveVRPWithORTools({
        cauldrons: cauldronsToOptimize,
        couriers: couriersToUse,
        market: marketToUse,
        distanceMatrix,
        optimizeForTime: false,  // Always minimize vehicles (witches), not time
        startTime: selectedTimePoint  // Pass selected time point for timeline visualization
      })

      setOptimizationResult(result)
    } catch (err: any) {
      console.error('Optimization error:', err)
      setError(err.message || 'Failed to solve optimization')
    } finally {
      setOptimizing(false)
    }
  }

  const refreshData = () => {
    if (dataStartTime && dataEndTime) {
      setLoading(true)
      setError(null)
      // Convert milliseconds to seconds (Unix timestamp) as expected by the API
      const startTimestampSeconds = Math.floor(dataStartTime / 1000)
      const endTimestampSeconds = Math.floor(dataEndTime / 1000)
      apiService.getHistoricalData(startTimestampSeconds, endTimestampSeconds)
        .then(data => {
          setHistoricalData(data)
          setLoading(false)
        })
        .catch(err => {
          console.error('Failed to fetch historical data:', err)
          
          // Extract more detailed error information
          let errorMessage = 'Failed to load historical data. ';
          if (err.apiError) {
            errorMessage += `Server returned ${err.apiError.status}: ${err.apiError.statusText || 'Internal Server Error'}. `;
            if (err.apiError.data && typeof err.apiError.data === 'string') {
              errorMessage += err.apiError.data;
            } else {
              errorMessage += 'The API server may be experiencing issues.';
            }
          } else {
            errorMessage += err.message || 'API server error. Please check if the API is running.';
          }
          
          setError(errorMessage)
          setLoading(false)
        })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-purple-400 mx-auto mb-4" />
          <p className="text-muted-foreground">Loading optimization data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-background/80 backdrop-blur-sm border-purple-500/30">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Timeline-Based Route Optimization</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={refreshData}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              onClick={solveOptimization}
              disabled={optimizing || selectedTimePoint === null || cauldronsToOptimize.length === 0}
              size="sm"
              className="gap-2 bg-purple-500 hover:bg-purple-600"
            >
              {optimizing ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Optimizing...
                </>
              ) : (
                <>
                  <Route className="h-4 w-4" />
                  Create Optimal Plan
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Timeline Selector */}
        {timeSpan && selectedTimePoint !== null && (
          <Card className="p-4 mb-6 border-purple-500/30 bg-purple-500/5">
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="h-5 w-5 text-purple-400" />
              <h3 className="text-lg font-semibold text-foreground">Select Time Point</h3>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {new Date(timeSpan.start).toLocaleString()}
                </span>
                <span className="font-semibold text-foreground">
                  Selected: {new Date(selectedTimePoint).toLocaleString()}
                </span>
                <span className="text-muted-foreground">
                  {new Date(timeSpan.end).toLocaleString()}
                </span>
              </div>
              <Slider
                value={[selectedTimePoint]}
                onValueChange={(values) => setSelectedTimePoint(values[0])}
                min={timeSpan.start}
                max={timeSpan.end}
                step={1000 * 60} // 1 minute steps
                className="purple"
              />
            </div>
          </Card>
        )}

        {/* Cauldrons Summary at Selected Time */}
        {allCauldronForecasts.length > 0 && (
          <Card className="p-4 mb-6 border-purple-500/30 bg-purple-500/5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  Cauldron Status at Selected Time
                </h3>
                <p className="text-sm text-muted-foreground">
                  {allCauldronsPrioritized.length} cauldron{allCauldronsPrioritized.length !== 1 ? 's' : ''} to service
                  ({allCauldronsPrioritized.filter(c => c.riskLevel === 'high').length} high-risk, 
                  {allCauldronsPrioritized.filter(c => c.riskLevel === 'medium').length} medium-risk, 
                  {allCauldronsPrioritized.filter(c => c.riskLevel === 'low').length} low-risk)
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge className="bg-red-500/10 text-red-500 border-red-500/30 text-lg px-3 py-1">
                  {allCauldronsPrioritized.filter(c => c.riskLevel === 'high').length} High
                </Badge>
                <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30 text-lg px-3 py-1">
                  {allCauldronsPrioritized.filter(c => c.riskLevel === 'medium').length} Med
                </Badge>
                <Badge className="bg-green-500/10 text-green-500 border-green-500/30 text-lg px-3 py-1">
                  {allCauldronsPrioritized.filter(c => c.riskLevel === 'low').length} Low
                </Badge>
              </div>
            </div>
          </Card>
        )}

        {/* Comparison Metrics */}
        {optimizationResult && naiveResult && (() => {
          // Calculate totals once to ensure consistency
          const naiveTotalWork = naiveResult.routes.reduce((sum, r) => sum + (r.totalTime || 0), 0)
          const optTotalWork = optimizationResult.routes.reduce((sum, r) => sum + (r.totalTime || 0), 0)
          
          return (
            <Card className="p-4 mb-6 border-blue-500/30 bg-blue-500/5">
              <h3 className="text-lg font-semibold text-foreground mb-4">Optimization Results</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-muted-foreground">Before Optimization (Naive)</div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Couriers:</span>
                      <span className="font-semibold text-foreground">{naiveResult.numCouriers}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Total Work Time:</span>
                      <span className="font-semibold text-foreground">
                        {Math.floor(naiveTotalWork / 60)}h {naiveTotalWork % 60}m
                      </span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-muted-foreground">After Optimization (OR-Tools)</div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Couriers:</span>
                      <span className="font-semibold text-green-500 flex items-center gap-1">
                        {optimizationResult.numCouriers}
                        {optimizationResult.numCouriers < naiveResult.numCouriers && (
                          <TrendingDown className="h-4 w-4" />
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Total Work Time:</span>
                      <span className="font-semibold text-green-500 flex items-center gap-1">
                        {Math.floor(optTotalWork / 60)}h {optTotalWork % 60}m
                        {optTotalWork < naiveTotalWork && (
                          <TrendingDown className="h-4 w-4" />
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-green-500" />
                    <span className="text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        {((1 - optimizationResult.numCouriers / naiveResult.numCouriers) * 100).toFixed(1)}%
                      </span> fewer couriers needed
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-green-500" />
                    <span className="text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        {naiveTotalWork > 0 ? ((1 - optTotalWork / naiveTotalWork) * 100).toFixed(1) : '0.0'}%
                      </span> total work time reduction
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          )
        })()}


        {/* Map Visualization */}
        {optimizationResult && (localNetwork || network) && (
          <Card className="p-6 mb-6 border-purple-500/30 bg-background/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-4">
              <MapIcon className="h-5 w-5 text-purple-400" />
              <h3 className="text-lg font-semibold text-foreground">Optimized Routes Visualization</h3>
            </div>
            <div className="h-[600px] rounded-lg overflow-hidden border border-border">
              <NetworkMap
                currentTime={0}
                onCauldronSelect={() => {}}
                selectedCauldron={null}
                cauldrons={cauldrons}
                network={localNetwork || network || null}
                couriers={localCouriers.length > 0 ? localCouriers : couriers}
                currentLevels={currentLevels as CauldronLevelsDto}
                market={localMarket || market}
                routes={optimizationResult.routes}
                cauldronRiskLevels={cauldronRiskLevels}
              />
            </div>
          </Card>
        )}

        {/* Optimization Results */}
        {optimizationResult && (
          <div className="space-y-4">
            <Card className="p-4 border-green-500/30 bg-green-500/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Users className="h-5 w-5 text-green-500" />
                    <span className="text-lg font-semibold text-foreground">
                      {optimizationResult.numCouriers} Courier{optimizationResult.numCouriers !== 1 ? 's' : ''} Required
                    </span>
                    {optimizationResult.numCouriers <= 4 && (
                      <Badge className="bg-green-500/20 text-green-500 border-green-500/30">
                        ✓ Within 4-Witch Limit
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-green-500" />
                    <span className="text-sm text-muted-foreground">
                      Total Work Time: {(() => {
                        const totalWork = optimizationResult.routes.reduce((sum, r) => sum + r.totalTime, 0)
                        return `${Math.floor(totalWork / 60)}h ${totalWork % 60}m`
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            <div>
              <h3 className="text-lg font-semibold text-foreground mb-4">Route Plan</h3>
              <div className="space-y-6">
                {optimizationResult.routes.map((route, idx) => {
                  const startTime = selectedTimePoint || Date.now()
                  
                  return (
                    <Card key={idx} className="p-6 border-purple-500/30 bg-background/80">
                      {/* Route Header */}
                      <div className="flex items-center justify-between mb-6 pb-4 border-b border-border">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                            <span className="text-lg font-bold text-purple-500">{idx + 1}</span>
                          </div>
                          <div>
                            <h4 className="text-lg font-semibold text-foreground">{route.courierName}</h4>
                            <p className="text-sm text-muted-foreground">Route {idx + 1} of {optimizationResult.routes.length}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-6 text-sm">
                          <div className="text-center">
                            <div className="flex items-center gap-1 text-muted-foreground mb-1">
                              <Package className="h-4 w-4" />
                              <span>Capacity</span>
                            </div>
                            <div className={`font-semibold ${route.totalVolume > 100 ? 'text-red-500' : 'text-foreground'}`}>
                              {route.totalVolume.toFixed(1)}L / 100L
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="flex items-center gap-1 text-muted-foreground mb-1">
                              <Clock className="h-4 w-4" />
                              <span>Duration</span>
                            </div>
                            <div className="font-semibold text-foreground">
                              {Math.floor(route.totalTime / 60)}h {route.totalTime % 60}m
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Route Timeline */}
                      <div className="space-y-4">
                        {/* Start */}
                        <div className="flex items-start gap-4">
                          <div className="flex flex-col items-center pt-1">
                            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center shadow-md">
                              <span className="text-xs font-bold text-white">S</span>
                            </div>
                            <div className="w-0.5 h-6 bg-border mt-1" />
                          </div>
                          <div className="flex-1 pb-4">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-semibold text-foreground">Start at Market</span>
                              <Badge variant="outline" className="text-xs">0h 0m</Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {new Date(startTime).toLocaleString()}
                            </p>
                          </div>
                        </div>

                        {/* Stops */}
                        {route.stops.map((stop, stopIdx) => {
                          const arrivalTime = stop.arrivalTime
                          const departureTime = arrivalTime + 5
                          const timeUntilOverflow = (stop as any).timeUntilOverflow
                          const isOnTime = timeUntilOverflow ? arrivalTime <= timeUntilOverflow : true
                          const originalCauldron = allCauldronForecasts.find(c => c.cauldronId === stop.cauldronId)
                          const isPartialPickup = originalCauldron && stop.pickupVolume < originalCauldron.demand && stop.pickupVolume < 100
                          const arrivalTimestamp = new Date(startTime + arrivalTime * 60000)
                          const departureTimestamp = new Date(startTime + departureTime * 60000)
                          
                          return (
                            <div key={stopIdx} className="flex items-start gap-4">
                              <div className="flex flex-col items-center pt-1">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center shadow-md ${
                                  isOnTime ? 'bg-purple-500' : 'bg-red-500'
                                }`}>
                                  <span className="text-xs font-bold text-white">{stopIdx + 1}</span>
                                </div>
                                {stopIdx < route.stops.length - 1 && (
                                  <div className="w-0.5 h-6 bg-border mt-1" />
                                )}
                              </div>
                              <div className="flex-1 pb-4">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="font-semibold text-foreground text-base">{stop.cauldronName}</span>
                                  {timeUntilOverflow && (
                                    <Badge className={isOnTime ? 'bg-green-500/10 text-green-500 border-green-500/30' : 'bg-red-500/10 text-red-500 border-red-500/30'}>
                                      {isOnTime ? '✓ On Time' : '⚠ LATE'}
                                    </Badge>
                                  )}
                                  {isPartialPickup && (
                                    <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30">
                                      Partial Pickup
                                    </Badge>
                                  )}
                                </div>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                  <div>
                                    <span className="text-muted-foreground">Arrives:</span>{' '}
                                    <span className="font-semibold text-foreground">
                                      {arrivalTimestamp.toLocaleTimeString()}
                                    </span>
                                    <span className="text-muted-foreground ml-2">
                                      ({Math.floor(arrivalTime / 60)}h {arrivalTime % 60}m)
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Pickup:</span>{' '}
                                    <span className="font-semibold text-foreground">
                                      {stop.pickupVolume.toFixed(1)}L
                                    </span>
                                    {isPartialPickup && originalCauldron && (
                                      <span className="text-yellow-500 ml-1">
                                        / {originalCauldron.demand.toFixed(1)}L
                                      </span>
                                    )}
                                    <span className="text-muted-foreground ml-2">(5 min)</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Departs:</span>{' '}
                                    <span className="font-semibold text-foreground">
                                      {departureTimestamp.toLocaleTimeString()}
                                    </span>
                                  </div>
                                  {timeUntilOverflow && (
                                    <div>
                                      <span className="text-muted-foreground">Overflow in:</span>{' '}
                                      <span className={isOnTime ? 'text-green-500' : 'text-red-500'}>
                                        {Math.floor(timeUntilOverflow / 60)}h {timeUntilOverflow % 60}m
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}

                        {/* End */}
                        {route.stops.length > 0 && (() => {
                          const lastStop = route.stops[route.stops.length - 1]
                          const lastDeparture = lastStop.arrivalTime + 5
                          const returnArrival = route.totalTime > 15 ? route.totalTime - 15 : lastDeparture + 30
                          const returnArrivalTimestamp = new Date(startTime + returnArrival * 60000)
                          const routeCompleteTimestamp = new Date(startTime + route.totalTime * 60000)
                          
                          return (
                            <div className="flex items-start gap-4">
                              <div className="flex flex-col items-center pt-1">
                                <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center shadow-md">
                                  <span className="text-xs font-bold text-white">E</span>
                                </div>
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="font-semibold text-foreground text-base">Return to Market</span>
                                  <Badge variant="outline" className="text-xs">
                                    {Math.floor(route.totalTime / 60)}h {route.totalTime % 60}m
                                  </Badge>
                                </div>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                  <div>
                                    <span className="text-muted-foreground">Arrives:</span>{' '}
                                    <span className="font-semibold text-foreground">
                                      {returnArrivalTimestamp.toLocaleTimeString()}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Unload:</span>{' '}
                                    <span className="font-semibold text-foreground">15 min</span>
                                  </div>
                                  <div className="col-span-2">
                                    <span className="text-muted-foreground">Route Complete:</span>{' '}
                                    <span className="font-semibold text-foreground">
                                      {routeCompleteTimestamp.toLocaleTimeString()}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )
                        })()}
                      </div>
                    </Card>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <Card className="p-4 border-red-500/30 bg-red-500/5">
            <p className="text-sm text-red-500">{error}</p>
          </Card>
        )}

      </Card>
    </div>
  )
}

// Call Python OR-Tools VRP solver API
async function solveVRPWithORTools(params: {
  cauldrons: CauldronForecast[]
  couriers: CourierDto[]
  market: MarketDto
  distanceMatrix: Map<string, Map<string, number>>
  optimizeForTime?: boolean
  startTime?: number
}): Promise<OptimizationResult> {
  const OPTIMIZATION_API_URL = import.meta.env.VITE_OPTIMIZATION_API_URL || 'http://localhost:5001';
  
  try {
    // Convert distance matrix to array format for JSON
    const distanceMatrixArray = Array.from(params.distanceMatrix.entries()).map(([from, toMap]) => ({
      from,
      to: Array.from(toMap.entries()).map(([to, time]) => ({ to, time }))
    }))
    
    const response = await fetch(`${OPTIMIZATION_API_URL}/optimize/routes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cauldrons: params.cauldrons,
        couriers: params.couriers,
        market: params.market,
        distanceMatrix: distanceMatrixArray,
        optimizeForTime: params.optimizeForTime || false,
        predictionHorizonMinutes: 480,  // Predict 8 hours ahead to prevent future overflows
        maxVehicles: 4  // Constrain to maximum 4 witches to find feasible solution
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Optimization API error: ${errorText || response.statusText}`);
    }

    const result = await response.json();
    return result;
  } catch (error: any) {
    // Fallback to simple greedy algorithm if API is not available
    console.warn('OR-Tools API not available, using fallback algorithm:', error);
    return solveGreedyVRP(params);
  }
}

// Fallback greedy VRP solver with split deliveries support
function solveGreedyVRP(params: {
  cauldrons: CauldronForecast[]
  couriers: CourierDto[]
  market: MarketDto
  distanceMatrix: Map<string, Map<string, number>>
}): OptimizationResult {
  const routes: Route[] = []
  const courierCapacity = 100  // Fixed: each courier can carry 100 liters

  // Split cauldrons with demand > 100L into multiple tasks
  interface SplitTask {
    cauldron: CauldronForecast
    remainingDemand: number
    pickupAmount: number
  }
  
  const tasks: SplitTask[] = []
  for (const cauldron of params.cauldrons) {
    let remaining = cauldron.demand
    while (remaining > 0) {
      const pickupAmount = Math.min(remaining, courierCapacity)
      tasks.push({
        cauldron,
        remainingDemand: remaining,
        pickupAmount
      })
      remaining -= pickupAmount
    }
  }

  // Sort tasks by urgency (time until overflow, then by demand)
  tasks.sort((a, b) => {
    const timeDiff = a.cauldron.timeUntilOverflow - b.cauldron.timeUntilOverflow
    if (timeDiff !== 0) return timeDiff
    return b.pickupAmount - a.pickupAmount
  })

  const unassigned = [...tasks]
  let courierIndex = 0

  // Simple greedy: assign tasks to routes based on urgency and capacity
  while (unassigned.length > 0 && courierIndex < params.couriers.length) {
    const courier = params.couriers[courierIndex]
    const route: Route = {
      courierId: courier.courier_id || `courier_${courierIndex}`,
      courierName: courier.name || `Courier ${courierIndex + 1}`,
      stops: [],
      totalVolume: 0,
      totalTime: 0
    }

    let currentLocation = params.market.id || 'market'
    let currentTime = 0

    // Greedily add tasks to route
    for (let i = unassigned.length - 1; i >= 0; i--) {
      const task = unassigned[i]
      if (route.totalVolume + task.pickupAmount <= courierCapacity) {
        // Calculate travel time
        const travelTime = params.distanceMatrix.get(currentLocation)?.get(task.cauldron.cauldronId) || 30
        const arrivalTime = currentTime + travelTime

        // Check if we can arrive before overflow
        if (arrivalTime <= task.cauldron.timeUntilOverflow) {
          route.stops.push({
            cauldronId: task.cauldron.cauldronId,
            cauldronName: task.cauldron.cauldronName,
            arrivalTime,
            pickupVolume: task.pickupAmount
          })
          route.totalVolume += task.pickupAmount
          currentTime = arrivalTime + 5 // 5 min pickup time at cauldron
          currentLocation = task.cauldron.cauldronId
          unassigned.splice(i, 1)
        }
      }
    }

    // Return to market
    if (route.stops.length > 0) {
      const returnTime = params.distanceMatrix.get(currentLocation)?.get(params.market.id || 'market') || 30
      route.totalTime = currentTime + returnTime + 15 // 15 min unload time
      
      // Combine stops to the same cauldron (for split deliveries)
      const combinedStops = new Map<string, typeof route.stops[0]>()
      for (const stop of route.stops) {
        if (combinedStops.has(stop.cauldronId)) {
          const existing = combinedStops.get(stop.cauldronId)!
          existing.pickupVolume += stop.pickupVolume
          if (stop.arrivalTime < existing.arrivalTime) {
            existing.arrivalTime = stop.arrivalTime
          }
        } else {
          combinedStops.set(stop.cauldronId, { ...stop })
        }
      }
      route.stops = Array.from(combinedStops.values()).sort((a, b) => a.arrivalTime - b.arrivalTime)
      
      routes.push(route)
    }

    courierIndex++
  }

  return {
    numCouriers: routes.length,
    routes,
    totalTime: Math.max(...routes.map(r => r.totalTime), 0)
  }
}

