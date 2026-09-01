/**
 * 诊断版专用：屏幕实时显示播放器内部状态（iPad 排错用，确认修复后可整体移除）。
 */

// 构建时由 NEXT_PUBLIC_BUILD_LABEL 注入（build-push.sh 传入镜像标签），不再硬编码
const DIAG_VERSION = process.env.NEXT_PUBLIC_BUILD_LABEL?.trim() || 'dev';
const MAX_LINES = 8;

let panel: HTMLDivElement | null = null;
const lines: string[] = [];

function ensurePanel(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'audio-diag-panel';
    panel.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      'z-index:99999',
      'background:rgba(0,0,0,0.78)',
      'color:#7CFC00',
      'font:10px/1.5 monospace',
      'padding:6px 8px',
      'border-radius:6px',
      'pointer-events:none',
      'white-space:pre',
      'max-width:70vw',
    ].join(';');
    document.body.appendChild(panel);
  }
  return panel;
}

export function diagVersion(): string {
  return DIAG_VERSION;
}

/** 诊断是否开启（面板/日志/版本提示共用此开关）。 */
export function diagEnabled(): boolean {
  return diagEnabledInternal();
}

const DIAG_FLAG_KEY = 'maic:audio-diag';

/** 诊断面板默认关闭；在控制台执行 localStorage.setItem('maic:audio-diag','1') 并刷新后开启。 */
function diagEnabledInternal(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DIAG_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function diagLog(message: string): void {
  if (typeof document === 'undefined' || !diagEnabledInternal()) return;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  lines.push(`${time} ${message}`);
  if (lines.length > MAX_LINES) lines.shift();
  const el = ensurePanel();
  if (el) el.textContent = [`[诊断 ${DIAG_VERSION}]`, ...lines].join('\n');
}
