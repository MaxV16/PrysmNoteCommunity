export type WatchlistMediaType = "movie" | "tv";
export type WatchlistStatus = "plan_to_watch" | "watching" | "watched";

export interface WatchlistUpcoming {
  label: string;
  date: string;
  extra?: string | null;
}

export interface WatchProvider {
  id: number | null;
  name: string;
  logo_path: string | null;
  display_priority?: number | null;
  link?: string | null;
}

export interface WatchProviders {
  flatrate?: WatchProvider[];
  buy?: WatchProvider[];
  rent?: WatchProvider[];
  free?: WatchProvider[];
}

export interface TMDBResult {
  tmdb_id: number;
  media_type: WatchlistMediaType;
  title: string;
  release_year: number | null;
  poster_path: string | null;
}

export interface WatchlistItem {
  id: string;
  tmdb_id: number;
  media_type: WatchlistMediaType;
  is_theatrical: boolean;
  title: string;
  poster_path: string | null;
  poster_url: string | null;
  release_year: number | null;
  status: WatchlistStatus;
  rating: number | null;
  notes: string | null;
  watched_at: string | null;
  upcoming: WatchlistUpcoming[];
  providers: WatchProviders;
  created_at: string | null;
}

export interface WatchlistUpdate {
  status?: WatchlistStatus;
  rating?: number | null;
  notes?: string | null;
  watched_at?: string | null;
}
