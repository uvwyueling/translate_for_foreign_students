import { afterEach, describe, expect, it, vi } from 'vitest';
import { findLocalEnglishVoice, waitForLocalEnglishVoice } from '../src/audio/local-voice';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('local English voice selection', () => {
  it('selects an installed English voice and excludes remote voices and other languages', () => {
    const local = { lang: 'en-US', localService: true };
    vi.stubGlobal('window', { speechSynthesis: true });
    vi.stubGlobal('speechSynthesis', { getVoices: () => [{ lang: 'en-GB', localService: false }, { lang: 'zh-CN', localService: true }, local] });
    expect(findLocalEnglishVoice()).toBe(local);
  });
  it('waits for asynchronously loaded voices and removes the event listener', async () => {
    vi.useFakeTimers();
    let voices: unknown[] = [];
    const events = new EventTarget(), remove = vi.spyOn(events, 'removeEventListener');
    vi.stubGlobal('window', { speechSynthesis: true });
    vi.stubGlobal('speechSynthesis', { getVoices: () => voices, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    const promise = waitForLocalEnglishVoice();
    const local = { lang: 'en-US', localService: true }; voices = [local]; events.dispatchEvent(new Event('voiceschanged'));
    expect(await promise).toBe(local); expect(remove).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('times out without silently choosing a remote voice', async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    vi.stubGlobal('window', { speechSynthesis: true });
    vi.stubGlobal('speechSynthesis', { getVoices: () => [{ lang: 'en-US', localService: false }], addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    const promise = waitForLocalEnglishVoice(); await vi.advanceTimersByTimeAsync(1500);
    expect(await promise).toBeUndefined();
  });
});
