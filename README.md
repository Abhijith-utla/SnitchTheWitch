# HackUTD 2025 - Logistics Dashboard

A modern web application for visualizing and managing logistics data from the HackUTD 2025 API.

## Features

- **Overview Dashboard**: Quick statistics and summary information
- **Network Visualization**: Interactive network graph with nodes and edges
- **Cauldrons Management**: View all cauldrons with their locations and capacities
- **Couriers Management**: Track couriers and their carrying capacities
- **Markets Information**: Display market details and locations
- **Tickets Management**: View transport tickets with filtering and search
- **Historical Data**: Interactive charts showing cauldron levels over time

## Tech Stack

- **React 18** with TypeScript
- **Vite** for fast development and building
- **Recharts** for data visualization
- **Axios** for API calls
- **React Router** for navigation

## Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn/pnpm

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser to `http://localhost:3000`

### Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

### Environment Variables

The application uses environment variables for API configuration. Create a `.env` file in the root directory:

```bash
# API Configuration
# Option 1: Use proxy (recommended to avoid CORS issues)
# Set this to 'true' to use relative URLs with deployment platform proxy
VITE_USE_PROXY=true

# Option 2: Direct API access (requires CORS to be enabled on API server)
# Set this to your API base URL (without trailing slash)
# For production, this should be the full URL like: https://hackutd2025.eog.systems
# For development, leave empty to use Vite proxy
# VITE_API_BASE_URL=https://hackutd2025.eog.systems

# Prophet API Configuration (optional)
# Set this if your Prophet API is hosted separately
# Default: http://localhost:5000
VITE_PROPHET_API_URL=http://localhost:5000

# Optimization API Configuration (optional)
# Set this if your Optimization API is hosted separately
# Default: http://localhost:5001
VITE_OPTIMIZATION_API_URL=http://localhost:5001

# Debug Mode (optional)
# Set to 'true' to enable API configuration logging
VITE_DEBUG_API=false
```

**Important**: Environment variables must be prefixed with `VITE_` to be accessible in the frontend code.

### Deployment

When deploying to production, make sure to:

1. **Set the API Base URL**: Configure `VITE_API_BASE_URL` in your deployment platform's environment variables
   - For Vercel: Add it in Project Settings → Environment Variables
   - For Netlify: Add it in Site Settings → Build & Deploy → Environment Variables
   - For other platforms: Set it according to their documentation

2. **Rebuild after setting environment variables**: The environment variables are embedded at build time, so you need to rebuild after changing them.

3. **Check the browser console**: If you see network errors, check the browser console for the API configuration log (if `VITE_DEBUG_API=true`) to see what URL is being used.

**Common Issues:**

1. **CORS Errors**: If you get "Network Error" or CORS errors after deployment, you have two options:
   
   **Option A: Use a Proxy (Recommended)**
   - Set `VITE_USE_PROXY=true` in your environment variables
   - Configure your deployment platform to proxy `/api/*` requests to `https://hackutd2025.eog.systems/api/*`
   - For Vercel: The `vercel.json` file is already configured
   - For Netlify: The `netlify.toml` file is already configured
   - This avoids CORS issues by making requests through your own domain
   
   **Option B: Direct API Access**
   - Set `VITE_API_BASE_URL=https://hackutd2025.eog.systems`
   - Ensure the API server allows CORS from your deployment domain
   - You may need to contact the API administrator to whitelist your domain

2. **Network Errors**: 
   - Check that `VITE_API_BASE_URL` is set correctly (if not using proxy)
   - Verify the API URL is accessible from the browser (not just from your local machine)
   - Check browser console for detailed error messages

3. **Proxy Configuration**:
   - If using Vercel: The `vercel.json` file handles proxying automatically
   - If using Netlify: The `netlify.toml` file handles proxying automatically
   - For other platforms: Configure rewrites/proxies to forward `/api/*` to `https://hackutd2025.eog.systems/api/*`

## API Endpoints

The application connects to the HackUTD 2025 API at `https://hackutd2025.eog.systems`:

- `/api/Data` - Historical cauldron level data
- `/api/Data/metadata` - Metadata about historical data
- `/api/Information/network` - Network graph structure
- `/api/Information/market` - Market information
- `/api/Information/couriers` - Courier information
- `/api/Information/cauldrons` - Cauldron information
- `/api/Information/graph/neighbors/{nodeId}` - Get neighbors for a node
- `/api/Tickets` - Transport tickets data

## Project Structure

```
src/
  ├── components/          # React components
  │   ├── Dashboard.tsx
  │   ├── NetworkView.tsx
  │   ├── CauldronsView.tsx
  │   ├── CouriersView.tsx
  │   ├── MarketsView.tsx
  │   ├── TicketsView.tsx
  │   └── HistoricalDataView.tsx
  ├── services/            # API service layer
  │   └── api.ts
  ├── types/               # TypeScript type definitions
  │   └── api.ts
  ├── App.tsx              # Main app component
  ├── main.tsx             # Entry point
  └── index.css            # Global styles
```

## License

MIT

