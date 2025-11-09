// API Types based on Swagger schema

export interface CauldronDto {
  id: string | null;
  name: string | null;
  latitude: number;
  longitude: number;
  max_volume: number;
}

export interface CauldronLevelsDto {
  cauldron_001: number;
  cauldron_002: number;
  cauldron_003: number;
  cauldron_004: number;
  cauldron_005: number;
  cauldron_006: number;
  cauldron_007: number;
  cauldron_008: number;
  cauldron_009: number;
  cauldron_010: number;
  cauldron_011: number;
  cauldron_012: number;
}

export interface CourierDto {
  courier_id: string | null;
  name: string | null;
  max_carrying_capacity: number;
}

export interface DateRange {
  start: string | null;
  end: string | null;
}

export interface EdgeDto {
  from: string | null;
  to: string | null;
  travel_time_minutes: number;
}

export interface HistoricalDataDto {
  timestamp: string;
  cauldron_levels: CauldronLevelsDto;
}

export interface HistoricalDataMetadataDto {
  start_date: string | null;
  end_date: string | null;
  interval_minutes: number;
  unit: string | null;
}

export interface MarketDto {
  id: string | null;
  name: string | null;
  latitude: number;
  longitude: number;
  description: string | null;
}

export interface NeighborDto {
  to: string | null;
  cost: string; // date-span format
}

export interface NetworkDto {
  edges: EdgeDto[] | null;
  description: string | null;
}

export interface TicketDto {
  ticket_id: string | null;
  cauldron_id: string | null;
  amount_collected: number;
  courier_id: string | null;
  date: string | null;
}

export interface TicketMetadataDto {
  total_tickets: number;
  suspicious_tickets: number;
  date_range: DateRange;
}

export interface TicketsDto {
  metadata: TicketMetadataDto;
  transport_tickets: TicketDto[] | null;
}

