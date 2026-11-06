// The live view's attach rule, shared by the server's WebRTC gate and the player (docs/CAMERA-ARCHITECTURE.md, NFR-1/10).
// A viewer may attach only while the recorder holds the camera's session, i.e. its ring got packets within this many
// seconds; otherwise the attach would make go2rtc dial the camera. The recorder's HLS gate uses the same number.
export const LIVE_ATTACH_MAX_RING_S = 15;

export const sessionHeld = (ringAgeS: number | null | undefined): boolean =>
  ringAgeS !== null && ringAgeS !== undefined && ringAgeS <= LIVE_ATTACH_MAX_RING_S;
