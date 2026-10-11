import type { BrowserWindow } from 'electron'

/** Actual Chromium cascade for small state signals, including rendered Markdown controls. */
export async function verifyPresentationFeedback(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const theme = document.documentElement.dataset.theme;
    const selected = document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title');
    const fixture = document.createElement('div');
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0';
    fixture.innerHTML = '<div class="provider-context"><i class="provider-context-track"><i class="provider-context-fill"></i></i></div><i class="terminal-move-live-dot"></i><div class="settings-fields"><label class="settings-checkbox-control"><input type="checkbox" checked><input type="checkbox"></label></div><button class="review-block-badge">1</button><span class="cm-review-anchor">Reviewed</span><div class="workbench-health-item">Incident</div>';
    document.body.append(fixture);
    const luminance = color => {
      const values = color.match(/[\\d.]+/g)?.slice(0, 3).map(Number);
      if (values?.length !== 3) throw new Error('State color did not resolve to RGB');
      return values.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; })
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    };
    const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
    try {
      [...document.querySelectorAll('.file-row')].find(row => row.querySelector('.tree-file-name')?.textContent?.trim() === 'rendered.md').click();
      const deadline = Date.now() + 10000;
      while (document.querySelector('.viewer-tab.active .tab-name')?.textContent?.trim() !== 'rendered.md' || !document.querySelector('.task-list-item-checkbox.inapplicable')) {
        if (Date.now() > deadline) throw new Error('Markdown state feedback fixture not ready');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      for (const appearance of ['dark', 'light']) {
        if (document.documentElement.dataset.theme !== appearance) document.querySelector('.theme-toggle').click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const readyDeadline = Date.now() + 10000;
        while (!document.querySelector('.task-list-item-checkbox:checked') || !document.querySelector('.task-list-item-checkbox.inapplicable')) {
          if (Date.now() > readyDeadline) throw new Error('Themed task feedback did not become ready');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const checked = document.querySelector('.task-list-item-checkbox:checked');
        const inactive = document.querySelector('.task-list-item-checkbox.inapplicable');
        const unchecked = document.querySelector('.task-list-item-checkbox:not(:checked):not(.inapplicable)');
        if (contrast(getComputedStyle(checked, '::after').borderBottomColor, getComputedStyle(checked).backgroundColor) < 3) throw new Error('Checked task mark lost contrast');
        if (contrast(getComputedStyle(inactive, '::after').backgroundColor, getComputedStyle(inactive).backgroundColor) < 3) throw new Error('Inapplicable task mark lost contrast');
        if (getComputedStyle(unchecked).backgroundColor === getComputedStyle(checked).backgroundColor) throw new Error('Task checked and unchecked states indistinct');
        const progress = fixture.querySelector('.provider-context');
        const track = fixture.querySelector('.provider-context-track');
        const fill = fixture.querySelector('.provider-context-fill');
        for (const state of ['', 'warning', 'critical']) {
          progress.className = 'provider-context ' + state;
          if (contrast(getComputedStyle(fill).backgroundColor, getComputedStyle(track).backgroundColor) < 3) throw new Error('Provider progress fill lost contrast: ' + state);
        }
        const accent = getComputedStyle(fixture.querySelector('input')).accentColor;
        fixture.style.color = 'var(--surface-1)';
        if (contrast(accent, getComputedStyle(fixture).color) < 3) throw new Error('Settings checkbox accent lost contrast');
        const dot = fixture.querySelector('.terminal-move-live-dot');
        if (!getComputedStyle(dot).boxShadow.includes('0.13')) throw new Error('Live-dot halo lost translucent treatment');
        const badge = fixture.querySelector('.review-block-badge');
        if (!getComputedStyle(badge).boxShadow.includes('0.3') || getComputedStyle(badge).backgroundColor === 'rgba(0, 0, 0, 0)') throw new Error('Review badge lost fill or translucent glow');
        for (const [state, border] of [['review-anchor-moved', 'dashed'], ['review-anchor-stale', 'double']]) {
          badge.className = 'review-block-badge ' + state;
          if (getComputedStyle(badge).borderTopStyle !== border) throw new Error('Review trust state lost border distinction: ' + state);
        }
        if (!getComputedStyle(fixture.querySelector('.cm-review-anchor')).backgroundColor.includes('0.13')) throw new Error('Review anchor lost translucent treatment');
        const health = fixture.querySelector('.workbench-health-item');
        const ordinary = getComputedStyle(health).borderLeftColor;
        health.classList.add('critical');
        if (getComputedStyle(health).borderLeftColor === ordinary) throw new Error('Health critical signal indistinct');
        health.classList.remove('critical');
      }
    } finally {
      fixture.remove();
      if (document.documentElement.dataset.theme !== theme) document.querySelector('.theme-toggle').click();
      [...document.querySelectorAll('.viewer-tab .tab-main')].find(tab => tab.getAttribute('title') === selected)?.click();
    }
  })()`)
}
