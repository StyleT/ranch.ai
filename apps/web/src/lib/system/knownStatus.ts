/** Keys shown first, in this order, for each daemon's retained status (the rest follow as chips). */
export const KNOWN_STATUS: Record<string, string[]> = {
  detector: ['model', 'family', 'taxonomy_version', 'compute', 'processed', 'dropped', 'inflight', 'bursts', 'raw_boxes', 'kept_boxes', 'rss_mb'],
  ingest: ['bursts', 'burst_frames', 'burst_throttled', 'burst_budget_per_min', 'motion_threshold', 'resets', 'rss_mb'],
  netprobe: [],
  status: ['rss_mb'],
};
