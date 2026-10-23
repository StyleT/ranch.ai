// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { StreamPlayer, retryDelayMs } from './StreamPlayer';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('StreamPlayer retry backoff', () => {
  it('doubles from 10 s and caps at 60 s', () => {
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
  });
  it('waits longer after each consecutive error and resets after a successful load', () => {
    vi.useFakeTimers();
    render(<StreamPlayer camera="donkey_cam" poster="/poster.jpg" fps={0.5} />);
    const player = screen.getByTestId('stream-player');
    const img = () => player.querySelector('img')!;
    expect(player.dataset.mode).toBe('buffer-mjpeg');

    fireEvent.error(img());
    expect(player.dataset.mode).toBe('error'); expect(player.dataset.retryS).toBe('10');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(player.dataset.mode).toBe('buffer-mjpeg');

    fireEvent.error(img());
    expect(player.dataset.retryS).toBe('20');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(player.dataset.mode).toBe('error');            // still waiting: the second wait is 20 s
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(player.dataset.mode).toBe('buffer-mjpeg');

    fireEvent.load(img());                               // frames arrive: the counter resets
    fireEvent.error(img());
    expect(player.dataset.retryS).toBe('10');
  });
});
