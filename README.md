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

