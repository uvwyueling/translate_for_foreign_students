import { useEffect, useState, useSyncExternalStore } from 'react';
import { ClassroomController, phaseLabels, type ClassroomState } from './lib/controller';
import { summarize } from './lib/metrics';
import type { Caption } from '../shared/protocol';

function duration(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function Captions({ captions }: { captions: Caption[] }) {
  return <div className="captions" aria-live="polite" aria-relevant="text additions">
    {captions.length ? captions.slice(-5).map((row, i, list) => <article className={`caption ${i === list.length - 1 ? 'latest' : ''}`} key={row.id}>
      <div className="caption-meta"><span>{new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })}</span><span>{row.final ? '已确认' : '正在修订'}</span></div>
      <p className="zh">{row.zh}</p><p className="en" lang="en">{row.en}</p>
    </article>) : <div className="empty"><span className="empty-symbol">Aa</span><h3>让每一句话，都被听懂</h3><p>开始课堂后，中文识别与英文翻译将在这里显示。</p></div>}
  </div>;
}
function CaptureStatus({ state }: { state: ClassroomState }) {
  const stages = { idle: '尚未启动', permission: '等待麦克风授权', resuming: '正在启动浏览器音频', worklet: '正在加载采音模块', capturing: '采音已启动', stopped: '已停止' };
  const capture = state.capture;
  return <><div className="metric-grid">
    <div><small>采音阶段</small><strong>{stages[capture.stage]}</strong></div>
    <div><small>浏览器采音状态 / 采样率</small><strong>{capture.contextState} / {capture.sampleRate ?? '—'} Hz</strong></div>
    <div><small>麦克风通道</small><strong>{capture.trackState === 'unavailable' ? '尚未取得' : capture.trackState === 'ended' ? '已断开' : !capture.trackEnabled ? '已禁用' : capture.trackMuted ? '系统暂时静音' : '正常'}</strong></div>
    <div><small>采音模块</small><strong>{capture.workletReady ? '已就绪' : '尚未就绪'}</strong></div>
    <div><small>采音回调 / 有输入回调</small><strong>{capture.renderCallbacks} / {capture.inputCallbacks}</strong></div>
    <div><small>已采集音频</small><strong>{capture.frames} 帧 / {(capture.frames * 0.04).toFixed(2)} 秒</strong></div>
    <div><small>网页已发往课堂服务</small><strong>{state.sentFrames} 帧</strong></div>
    <div><small>启动音频等待发送</small><strong>{state.pendingFrames} 帧</strong></div>
  </div><p>故障时保留停止前的采音状态。网页发出帧数只表示已交给浏览器连接发送，不证明后端或讯飞已收到；模拟模式也可检查采音和网页发送。</p></>;
}
export default function App({ controller }: { controller: ClassroomController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const active = ['connecting', 'running', 'reconnecting'].includes(state.phase);
  const busy = active || state.phase === 'checking';
  useEffect(() => {
    void controller.checkHealth();
    const unload = (event: BeforeUnloadEvent) => { if (['running', 'connecting', 'reconnecting'].includes(controller.getSnapshot().phase)) { event.preventDefault(); event.returnValue = ''; } };
    const close = () => controller.dispose();
    window.addEventListener('beforeunload', unload); window.addEventListener('pagehide', close);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', close); };
  }, [controller]);
  const micLabels = { unchecked: '待检查', checking: '请说几句话', ok: '检测到输入', silent: '未检测到声音', error: '请检查设备' };
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="听见课堂首页"><span className="brand-mark">听</span><span>听见课堂<small>CLASSROOM INTERPRETER</small></span></a><div className="top-meta"><span className="version">V0 试验版</span><span className={`mode-chip ${state.mode}`}>{state.mode === 'mock' ? '模拟模式 · 固定示例' : '真实同传 · 中文 → 英文'}</span></div></header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">TEACHER WORKSPACE</div><h1>专注授课，连接每一位学生。</h1><p>中文授课 · 双语字幕 · 一路英文语音</p></div><div className="class-time"><span>本次课堂</span><strong>{duration(state.metrics.activeSeconds)}</strong><small>建议单节 45 分钟</small></div></div>
      {state.mode === 'mock' && <div className="mock-banner"><span className="banner-icon">◇</span><span><strong>当前为模拟演示</strong>　字幕来自固定示例，与麦克风讲话无关；英文由浏览器朗读。此模式不验证翻译质量或云端延迟。</span></div>}
      <div className="workspace">
        <aside className="sidebar">
          <section className="card setup"><div className="section-title"><h2><span className="step">01</span> 课前准备</h2><span className="muted">先检查，再开始</span></div>
            <label className="field-label" htmlFor="mode">课堂模式</label><select id="mode" value={state.mode} disabled={busy} onChange={e => controller.setMode(e.target.value as 'mock' | 'live')}><option value="mock">模拟演示（不消耗讯飞额度）</option><option value="live">真实同传（需要服务已配置）</option></select>
            {state.mode === 'live' && <div className="token-field"><label className="field-label" htmlFor="token">课堂口令</label><input id="token" type="password" autoComplete="off" disabled={busy} placeholder="由项目负责人提供" onChange={e => controller.setToken(e.target.value)}/><small>{state.liveConfigured ? '后端已配置，实际可用性以连接结果为准。' : '后端尚未配置真实服务，仍可切换至模拟模式。'}</small></div>}
            <div className="check-row"><span className={`check-dot ${state.microphone === 'ok' ? 'ok' : ''}`}/><div><strong>麦克风输入</strong><small>{micLabels[state.microphone]}</small></div><div className="level" role="meter" aria-label="麦克风输入音量" aria-valuenow={Math.round(Math.min(state.level * 500, 100))} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(state.level * 500, 100)}%` }}/></div></div>
            <div className="check-row"><span className={`check-dot ${state.service === 'ok' ? 'ok' : ''}`}/><div><strong>课堂服务</strong><small>{state.service === 'ok' ? '网页服务可访问' : state.service === 'error' ? '无法访问，请检查网络' : '待检查'}</small></div></div>
            <div className="button-pair"><button disabled={busy} onClick={() => void controller.check()}>检查麦克风</button><button disabled={busy} onClick={() => void controller.testAudio()}>▷ 英文试听</button></div>
            <p className="helper">试听后，请确认声音已进入学生耳机线路。<br/>授课时保持页面在前台，电脑不要休眠。</p>
          </section>
          <section className="card control"><div className="section-title"><h2><span className="step">02</span> 课堂控制</h2><span className={`status-pill ${state.phase}`}>{phaseLabels[state.phase]}</span></div>
            <div className="status-message" role="status">{state.message}</div>
            {active ? <button className="primary large" onClick={() => controller.pause()}>Ⅱ　暂停课堂</button> : <button className="primary large" disabled={state.phase === 'checking' || (state.mode === 'live' && !state.liveConfigured)} onClick={() => void controller.start()}>{state.phase === 'paused' ? '▶　继续课堂' : state.phase === 'error' ? '↻　手动重试' : '▶　开始课堂'}</button>}
            <button className="end-button" disabled={['idle', 'ended'].includes(state.phase)} onClick={() => controller.end()}>结束课堂</button>
            {state.mode === 'live' && <div className="speech-mode-field"><label className="field-label" htmlFor="segmentation">分句方式</label><select id="segmentation" value={state.segmentation} disabled={busy} onChange={e => controller.setSegmentation(e.target.value as 'continuous' | 'pause')}><option value="continuous">连续同传（原方式）</option><option value="pause">停顿后尽快送译（实验）</option></select><p className="helper">{state.segmentation === 'pause' ? '停顿约 0.8 秒后收尾送译，再自动接下一段。较长的句内停顿也可能分句，请检查漏字和翻译完整性。' : '保持连续会话，由服务判断分句。短句说完后可能等待较久。'}</p></div>}
            {state.mode === 'live' && <div className="speech-mode-field"><label className="field-label" htmlFor="speech-mode">英文声音来源</label><select id="speech-mode" value={state.speechMode} disabled={busy} onChange={e => controller.setSpeechMode(e.target.value as 'provider' | 'local')}><option value="provider">讯飞英文语音（原方式）</option><option value="local">本机朗读英文字幕（对比测试）</option></select><p className="helper">{state.speechMode === 'local' ? '收到已确认的英文字幕后，用本机英语语音朗读。不播放讯飞声音；效果和速度需实测，待播时长为估算。' : '播放讯飞返回的英文语音。若每句等待较长，可结束后切换本机朗读做对比。'}</p></div>}
            <div className="audio-heading"><span>英文播放</span><span className="muted">{state.playing ? '正在播放' : '等待语音'}</span></div>
            <label className="volume"><span>音量</span><input type="range" min="0" max="1" step="0.05" value={state.volume} onChange={e => controller.setVolume(Number(e.target.value))}/><span>{Math.round(state.volume * 100)}%</span></label>
            <div className={`queue ${state.queueSeconds > 15 ? 'warning' : ''}`}><div><strong>{state.queueSeconds.toFixed(1)}<small> 秒</small></strong><span>待播时长{state.mode === 'mock' || state.speechMode === 'local' ? '（估算）' : ''}</span></div><button onClick={() => controller.clearQueue()} disabled={!active && state.queueSeconds === 0}>清空待播<br/>回到当前</button></div>
            {state.playbackError && <div className="error-note" role="alert">{state.playbackError}<button onClick={() => void controller.resumeAudio()}>恢复播放</button></div>}
          </section>
        </aside>
        <section className="card subtitle-panel"><div className="subtitle-heading"><div><div className="eyebrow">LIVE CAPTIONS</div><h2>课堂双语字幕</h2></div><button className="projection-button" onClick={() => controller.openProjection()}>↗　{state.projectionOpen ? '返回字幕窗口' : '打开字幕窗口'}</button></div>
          <div className="subtitle-note"><span className={`live-dot ${state.phase === 'running' ? 'on' : ''}`}/>{state.mode === 'mock' ? '固定示例 · 模拟字幕' : state.phase === 'running' ? '正在接收课堂内容' : '等待课堂开始'}<span className="language-pair">中文 <span>→</span> ENGLISH</span></div>
          <Captions captions={state.captions}/>
          {state.draft && <div className="draft"><span>中文识别中</span>{state.draft}</div>}
          <div className="subtitle-footer"><span>字幕先显示，英文语音按顺序播放。</span><span>仅保留本次页面最近 60 条</span></div>
        </section>
      </div>
      <section className="diagnostics"><button className="text-button" onClick={() => setShowDiagnostics(!showDiagnostics)} aria-expanded={showDiagnostics}>{showDiagnostics ? '▾' : '▸'} 运行数据与排查</button><span>音频与课堂字幕不写入数据库</span>{showDiagnostics && <div className="diagnostic-body"><div className="metric-grid"><div><small>连接往返耗时</small><strong>{state.metrics.rttMs === null ? '—' : `${state.metrics.rttMs} ms`}</strong></div><div><small>上传用量估算</small><strong>{(state.metrics.uploadedSeconds / 60).toFixed(2)} 分钟</strong></div><div><small>重建 / 中断次数</small><strong>{state.metrics.reconnects} / {state.metrics.interruptions}</strong></div><div><small>最大待播</small><strong>{state.metrics.maxQueueSeconds.toFixed(1)} 秒</strong></div><div><small>最近音频的网页排队等待</small><strong>{state.metrics.audioQueueWaitMs.length ? `${(state.metrics.audioQueueWaitMs.at(-1)! / 1000).toFixed(2)} 秒` : "—"}</strong></div><div><small>英文字幕首次出现→确认（最近）</small><strong>{state.metrics.captionConfirmationMs.length ? `${(state.metrics.captionConfirmationMs.at(-1)! / 1000).toFixed(2)} 秒` : "—"}</strong></div><div><small>确认→本机朗读启动（最近）</small><strong>{state.metrics.localSpeechStartMs.length ? `${(state.metrics.localSpeechStartMs.at(-1)! / 1000).toFixed(2)} 秒` : "—"}</strong></div><div><small>最终字幕延迟中位数（近似）</small><strong>{summarize(state.metrics.finalLatencyMs)?.medianMs ?? '—'} ms</strong></div></div><CaptureStatus state={state}/><p>连接往返耗时不代表翻译延迟。模拟模式不产生真实翻译延迟数据；网页排队等待不包含云端处理、网络和声卡延迟；本机朗读启动依据浏览器开始事件，不代表扬声器发声时刻；两项最近值可能属于不同片段，不能直接相加。英文起播延迟待人工标记实测。</p>{state.detail && <p className="error-note">排查信息：{state.detail}</p>}<div className="button-pair"><button onClick={() => controller.exportMetrics()}>下载运行数据（不含课堂正文）</button><button disabled={!active} onClick={() => controller.simulateDisconnect()}>测试断连恢复</button></div></div>}</section>
      <footer className="page-footer"><span>听见课堂 / V0</span><span>试验阶段 · 真实服务与学校设备仍需联调验收</span></footer>
    </main>
  </div>;
}
