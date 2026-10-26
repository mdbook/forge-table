import { describe, expect, it } from 'vitest';
import { restartText } from './TableHud';

describe('restart banner', () => {
  it('counts down to the restart', () => {
    expect(restartText(null, 0)).toBeNull();
    expect(restartText(60_000, 0)).toBe('Server restarting in 60 s; your game will end.');
    expect(restartText(60_000, 59_100)).toBe('Server restarting in 1 s; your game will end.');
    expect(restartText(60_000, 61_000)).toBe('Server restarting now; your game is ending.');
  });
});
