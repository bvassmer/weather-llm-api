export type AlertSortBy = "event" | "headline" | "effectiveAt" | "id";

export type SortDirection = "asc" | "desc";

export interface AlertListItem {
  id: number;
  event: string | null;
  headline: string | null;
  effectiveAt: string | null;
}

export interface ListAlertsQuery {
  query?: string;
  event?: string;
  headline?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  sortBy?: AlertSortBy;
  sortDir?: SortDirection;
  page?: number | string;
  pageSize?: number | string;
}

export interface ListAlertsResponse {
  items: AlertListItem[];
  page: number;
  pageSize: number;
  total: number;
  sortBy: AlertSortBy;
  sortDir: SortDirection;
}

export interface AlertDetails {
  id: number;
  nwsId: string | null;
  event: string | null;
  headline: string | null;
  description: string | null;
  shortDescription: string | null;
  geometry: string | null;
  sent: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  ends: string | null;
}

export interface UpdateAlertRequest {
  nwsId?: string | null;
  event?: string | null;
  headline?: string | null;
  description?: string | null;
  shortDescription?: string | null;
  geometry?: string | null;
  sent?: string | null;
  effective?: string | null;
  onset?: string | null;
  expires?: string | null;
  ends?: string | null;
}

export interface DeleteAlertResponse {
  id: number;
  deleted: boolean;
}
