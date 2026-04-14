// Frames sent from relay → GRASS (over WS)
export type RelayToGrassFrame =
  | { type: 'registered' }
  | { type: 'register_error'; reason: string }
  | { requestId: string; type: 'request'; method: string; path: string; headers: Record<string, string>; body: string }

// Frames sent from GRASS → relay (over WS)
export type GrassToRelayFrame =
  | { type: 'register'; token: string }
  | { requestId: string; type: 'response_start'; statusCode: number; headers: Record<string, string> }
  | { requestId: string; type: 'data'; chunk: string }  // utf-8 string chunk
  | { requestId: string; type: 'end' }
  | { requestId: string; type: 'error'; message: string }
