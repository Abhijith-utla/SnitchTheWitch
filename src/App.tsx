import { useState } from 'react'
import { Button } from './components/ui/button'
import { Sparkles, Compass, TrendingUp, Route } from 'lucide-react'
import GraphsTab from './components/GraphsTab'
import Dashboard from './components/Dashboard'
import LandingPage from './components/LandingPage'
import ForecastingTab from './components/ForecastingTab'
import OptimizationTab from './components/OptimizationTab'

function App() {
  const [showLanding, setShowLanding] = useState(true)
  const [activeTab, setActiveTab] = useState<'graphs' | 'map' | 'forecasting' | 'optimization'>('graphs')
  const [appData, setAppData] = useState<{
    cauldrons: any[]
    historicalData: any[]
    tickets: any
    network: any
    couriers: any[]
    market: any
    dataStartTime: number
    dataEndTime: number
  } | null>(null)

  if (showLanding) {
    return <LandingPage onEnter={() => {
      setShowLanding(false)
      setActiveTab('map') // Go to Dashboard/Map view
    }} />
  }

  return (
    <div className="min-h-screen bg-background relative">

      {/* Content Layer */}
      <div className="relative z-10">
          {/* Minimal Navbar */}
          <nav className="border-b border-purple-500/30 bg-gradient-to-r from-purple-950/20 via-purple-900/20 to-purple-950/20 backdrop-blur-sm sticky top-0 z-50 magical-glow">
            <div className="max-w-[1920px] mx-auto px-4 md:px-6 lg:px-8">
              <div className="flex items-center justify-between h-14">
                <div 
                  className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() => setShowLanding(true)}
                >
                  <h1 className="text-xl font-bold text-magical">
                    SnitchTheWitch
                  </h1>
                </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant={activeTab === 'graphs' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setActiveTab('graphs')}
                        className={`gap-2 magical-border ${
                          activeTab === 'graphs' 
                            ? 'bg-purple-500 hover:bg-purple-600 text-white border-purple-400' 
                            : 'text-purple-300 hover:bg-purple-500/20 border-purple-500/50'
                        }`}
                      >
                        <Sparkles className="h-4 w-4" />
                        Crystal Visions
                      </Button>
                      <Button
                        variant={activeTab === 'map' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setActiveTab('map')}
                        className={`gap-2 magical-border ${
                          activeTab === 'map' 
                            ? 'bg-purple-500 hover:bg-purple-600 text-white border-purple-400' 
                            : 'text-purple-300 hover:bg-purple-500/20 border-purple-500/50'
                        }`}
                      >
                        <Compass className="h-4 w-4" />
                        Enchanted Map
                      </Button>
                      <Button
                        variant={activeTab === 'forecasting' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setActiveTab('forecasting')}
                        className={`gap-2 magical-border ${
                          activeTab === 'forecasting' 
                            ? 'bg-purple-500 hover:bg-purple-600 text-white border-purple-400' 
                            : 'text-purple-300 hover:bg-purple-500/20 border-purple-500/50'
                        }`}
                      >
                        <TrendingUp className="h-4 w-4" />
                        Forecasting
                      </Button>
                      <Button
                        variant={activeTab === 'optimization' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setActiveTab('optimization')}
                        className={`gap-2 magical-border ${
                          activeTab === 'optimization' 
                            ? 'bg-purple-500 hover:bg-purple-600 text-white border-purple-400' 
                            : 'text-purple-300 hover:bg-purple-500/20 border-purple-500/50'
                        }`}
                      >
                        <Route className="h-4 w-4" />
                        Optimization
                      </Button>
                    </div>
              </div>
            </div>
          </nav>

      {/* Tab Content */}
      <div className="max-w-[1920px] mx-auto p-4 md:p-6 lg:p-8">
        {activeTab === 'graphs' ? (
          appData ? (
            <GraphsTab
              cauldrons={appData.cauldrons}
              historicalData={appData.historicalData}
              tickets={appData.tickets?.transport_tickets || []}
              dataStartTime={appData.dataStartTime}
              dataEndTime={appData.dataEndTime}
            />
          ) : (
            <Dashboard onDataLoad={setAppData} showMap={false} />
          )
        ) : activeTab === 'forecasting' ? (
          appData ? (
            <ForecastingTab
              cauldrons={appData.cauldrons}
              historicalData={appData.historicalData}
              dataStartTime={appData.dataStartTime}
              dataEndTime={appData.dataEndTime}
            />
          ) : (
            <Dashboard onDataLoad={setAppData} showMap={false} />
          )
        ) : activeTab === 'optimization' ? (
          appData ? (
            <OptimizationTab
              cauldrons={appData.cauldrons}
              historicalData={appData.historicalData}
              network={appData.network}
              couriers={appData.couriers}
              market={appData.market}
              dataStartTime={appData.dataStartTime}
              dataEndTime={appData.dataEndTime}
            />
          ) : (
            <Dashboard onDataLoad={setAppData} showMap={false} />
          )
        ) : (
          <Dashboard onDataLoad={setAppData} />
        )}
      </div>
      </div>
    </div>
  )
}

export default App

