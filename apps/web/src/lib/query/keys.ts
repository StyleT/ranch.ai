export const keys = {
  home: () => ['home'] as const,
  camera: (name: string, window: string) => ['camera', name, window] as const,
  detections: (params: string) => ['detections', params] as const,
  detection: (id: number) => ['detection', id] as const,
  baselineSets: () => ['baseline-sets'] as const,
  taxonomy: () => ['taxonomy'] as const,
  taxonomyVersion: (id: number) => ['taxonomy', 'version', id] as const,
  system: () => ['system'] as const,
  evals: () => ['evals'] as const,
  result: (file: string) => ['evals', 'result', file] as const,
  health: () => ['health'] as const,
};
