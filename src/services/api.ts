import axios from 'axios';
import type {
  CauldronDto,
  CourierDto,
  HistoricalDataDto,
  HistoricalDataMetadataDto,
  MarketDto,
  NetworkDto,
  TicketsDto,
  NeighborDto,
} from '../types/api';

// Use environment variable if set, otherwise:
// - In development: use relative URL (proxied through Vite)
// - In production: default to relative URL (empty) to use deployment platform proxy
//   This avoids CORS issues by making requests through your own domain
//   Only use direct API URL if explicitly set via VITE_API_BASE_URL
// This allows using deployment platform proxies (Vercel/Netlify) to avoid CORS issues
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 
  (import.meta.env.MODE === 'development' ? '' : '');

// Log API configuration for debugging
// Always log in production to help debug deployment issues
if (import.meta.env.MODE === 'development' || import.meta.env.VITE_DEBUG_API === 'true' || import.meta.env.MODE === 'production') {
  console.log('API Configuration:', {
    mode: import.meta.env.MODE,
    baseURL: API_BASE_URL || '(relative - using proxy)',
    hasEnvVar: !!import.meta.env.VITE_API_BASE_URL,
    note: API_BASE_URL ? 'Using direct API URL' : 'Using relative URLs (proxy required)'
  });
}

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 second timeout
});

// Add response interceptor for better error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.code === 'ERR_NETWORK') {
      const attemptedUrl = error.config?.baseURL + error.config?.url || 'unknown';
      const isCorsIssue = error.message?.includes('CORS') || 
                         error.message?.includes('Access-Control') ||
                         (error.code === 'ERR_NETWORK' && !error.response);
      
      console.error('Network Error:', {
        code: error.code,
        url: attemptedUrl,
        baseURL: API_BASE_URL || '(relative)',
        message: error.message,
        isCorsIssue,
        suggestion: isCorsIssue ? 'This is likely a CORS issue. The API server needs to allow requests from your deployment domain, or use a proxy.' : 'Check if the API server is running and accessible.'
      });
      
      if (isCorsIssue) {
        error.message = `CORS Error: The API at ${attemptedUrl} is blocking requests from this domain. The API server needs to allow CORS from your deployment domain, or configure a proxy.`;
      } else {
        error.message = `Network Error: Unable to connect to the API at ${attemptedUrl}. Please check your internet connection or if the API server is running.`;
      }
    } else if (error.response) {
      // Server responded with error status
      const status = error.response.status;
      const statusText = error.response.statusText;
      const errorData = error.response.data;
      
      // Try to extract more detailed error message from response
      let detailedMessage = statusText;
      if (errorData) {
        if (typeof errorData === 'string') {
          detailedMessage = errorData;
        } else if (errorData.error || errorData.message) {
          detailedMessage = errorData.error || errorData.message;
        }
      }
      
      error.message = `API Error: ${status} - ${detailedMessage}`;
      error.apiError = {
        status,
        statusText,
        data: errorData,
        url: error.config?.url
      };
    } else if (error.request) {
      // Request made but no response received
      error.message = 'No response from server. The API may be down or unreachable.';
    }
    return Promise.reject(error);
  }
);

export const apiService = {
  // Data endpoints
  async getHistoricalData(startDate?: number, endDate?: number): Promise<HistoricalDataDto[]> {
    const params: Record<string, number> = {};
    if (startDate !== undefined) params.start_date = startDate;
    if (endDate !== undefined) params.end_date = endDate;
    
    const response = await api.get<HistoricalDataDto[]>('/api/Data', { params });
    return response.data;
  },

  async getHistoricalDataMetadata(): Promise<HistoricalDataMetadataDto> {
    const response = await api.get<HistoricalDataMetadataDto>('/api/Data/metadata');
    return response.data;
  },

  // Information endpoints
  async getNetwork(): Promise<NetworkDto> {
    const response = await api.get<NetworkDto>('/api/Information/network');
    return response.data;
  },

  async getMarket(): Promise<MarketDto> {
    const response = await api.get<MarketDto>('/api/Information/market');
    return response.data;
  },

  async getCouriers(): Promise<CourierDto[]> {
    const response = await api.get<CourierDto[]>('/api/Information/couriers');
    return response.data;
  },

  async getCauldrons(): Promise<CauldronDto[]> {
    const response = await api.get<CauldronDto[]>('/api/Information/cauldrons');
    return response.data;
  },

  async getNeighbors(nodeId: string): Promise<NeighborDto[]> {
    const response = await api.get<NeighborDto[]>(`/api/Information/graph/neighbors/${nodeId}`);
    return response.data;
  },

  async getDirectedNeighbors(nodeId: string): Promise<NeighborDto[]> {
    const response = await api.get<NeighborDto[]>(`/api/Information/graph/neighbors/directed/${nodeId}`);
    return response.data;
  },

  // Tickets endpoint
  async getTickets(): Promise<TicketsDto> {
    const response = await api.get<TicketsDto>('/api/Tickets');
    return response.data;
  },

  // Prophet forecasting endpoint
  async forecastProphet(
    timeSeries: Array<{ timestamp: string; value: number }>,
    periods: number = 144,
    freq: string = '10min'
  ): Promise<{
    forecast: Array<{
      ds: string;
      yhat: number;
      yhat_lower: number;
      yhat_upper: number;
      trend?: number;
      weekly?: number;
      daily?: number;
    }>;
    trend?: number[];
    weekly_seasonal?: number[];
    daily_seasonal?: number[];
  }> {
    // Call Python Prophet API
    const PROPHET_API_URL = import.meta.env.VITE_PROPHET_API_URL || 'http://localhost:5000';
    
    const response = await fetch(`${PROPHET_API_URL}/forecast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: timeSeries,
        periods,
        freq
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Prophet forecast failed');
    }

    return response.json();
  },

  // Batch forecast for multiple cauldrons
  async forecastProphetBatch(
    cauldrons: Record<string, Array<{ timestamp: string; value: number }>>,
    periods: number = 144,
    freq: string = '10min'
  ): Promise<Record<string, Array<{
    ds: string;
    yhat: number;
    yhat_lower: number;
    yhat_upper: number;
  }>>> {
    const PROPHET_API_URL = import.meta.env.VITE_PROPHET_API_URL || 'http://localhost:5000';
    
    console.log(`Calling Prophet API at ${PROPHET_API_URL}/forecast/batch`);
    
    try {
      const response = await fetch(`${PROPHET_API_URL}/forecast/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cauldrons,
          periods,
          freq
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = 'Prophet batch forecast failed';
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorMessage;
        } catch {
          errorMessage = errorText || `HTTP ${response.status}: ${response.statusText}`;
        }
        console.error('Prophet API error:', errorMessage);
        throw new Error(errorMessage);
      }

      const result = await response.json();
      console.log('Prophet API response received:', {
        cauldrons: Object.keys(result.results || {}),
        hasResults: !!result.results
      });
      return result.results || {};
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('Failed to connect to Prophet API. Is the Python server running?');
        throw new Error('Cannot connect to Prophet API. Please ensure the Python server is running on port 5000.');
      }
      throw error;
    }
  },
};

