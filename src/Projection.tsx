import { useEffect, useState } from 'react';
import type { Caption, Mode, Phase } from '../shared/protocol';
import { phaseLabels } from './lib/controller';
interface Snapshot { type: 'snapshot'; captions: Caption[]; draft: string; phase: Phase; mode: Mode; at: number }
export default function Projection() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [fontSize, setFontSize] = useState(46);
  const [contrast, setContrast] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id || !('BroadcastChannel' in window)) { setError('请从教师控制页点击“打开字幕窗口”。此窗口需要同一浏览器的窗口同步支持。'); return; }
    const channel = new BroadcastChannel(`classroom-${id}`);
    channel.onmessage = event => { if (event.data?.type === 'snapshot') setSnapshot(event.data); };
    channel.postMessage({ type: 'request' });
    const interval = setInterval(() => { setNow(Date.now()); channel.postMessage({ type: 'request' }); }, 2000);
    return () => { clearInterval(interval); channel.close(); };
  }, []);
  const connected = !!snapshot && now - snapshot.at < 6000;
  const rows = snapshot?.captions.slice(-2) ?? [];
  return <main className={`projection ${contrast ? 'high-contrast' : ''}`} style={{ '--caption-size': `${fontSize}px` } as React.CSSProperties}>
    <div className="projection-toolbar"><strong>听见课堂 · 双语字幕</strong><span>{snapshot?.mode === 'mock' ? '模拟模式 · 固定示例' : '中文 → English'}</span><label>字号 <input aria-label="投影字幕字号" type="range" min="28" max="80" value={fontSize} onChange={e => setFontSize(Number(e.target.value))}/></label><button onClick={() => setContrast(!contrast)}>高对比度：{contrast ? '开' : '关'}</button><button onClick={() => { void document.documentElement.requestFullscreen().catch(() => setError('全屏被浏览器拒绝，请按 F11 或使用浏览器全屏菜单。')); }}>全屏</button></div>
    <div className="projection-status">{!connected ? '未连接教师页面 · 请返回控制台检查' : phaseLabels[snapshot.phase]}{snapshot?.mode === 'mock' && ' ｜ 示例内容，与实际讲话无关'}</div>
    {error && <p role="alert">{error}</p>}
    <div className="projection-captions" aria-live="polite">{rows.length ? rows.map(row => <article key={row.id}><p className="projection-zh">{row.zh}</p><p className="projection-en" lang="en">{row.en}</p>{!row.final && <small>正在修订 / Updating</small>}</article>) : <div className="projection-empty"><h1>等待课堂开始</h1><p>Waiting for the class to begin</p></div>}</div>
    {snapshot?.draft && <p className="projection-draft">{snapshot.draft}</p>}
    <div className="projection-bottom">{!connected ? '教师页面已断开，以下仅为最近字幕。' : snapshot?.phase === 'paused' ? '课堂已暂停 / Class paused' : '请佩戴耳机收听英文语音 / Please use your headphones for English audio'}</div>
  </main>;
}
