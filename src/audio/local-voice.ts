export function findLocalEnglishVoice(): SpeechSynthesisVoice | undefined {
  if (!('speechSynthesis' in window)) return undefined;
  return speechSynthesis.getVoices().find(voice => /^en(?:[-_]|$)/i.test(voice.lang) && voice.localService);
}
export async function waitForLocalEnglishVoice(timeoutMs = 1500): Promise<SpeechSynthesisVoice | undefined> {
  const existing = findLocalEnglishVoice();
  if (existing || !('speechSynthesis' in window)) return existing;
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); speechSynthesis.removeEventListener('voiceschanged', changed); resolve(findLocalEnglishVoice()); };
    const changed = () => { if (findLocalEnglishVoice()) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    speechSynthesis.addEventListener('voiceschanged', changed);
  });
}
