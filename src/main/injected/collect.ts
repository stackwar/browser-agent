/**
 * 注入页面执行的元素采集脚本。
 *
 * 这里刻意保存为**字符串**而不是真实函数:主进程的 tsconfig 不含 DOM lib,
 * 而这段代码运行在页面上下文里,通过 Runtime.evaluate 下发。
 * 修改时请留意它不受 TypeScript 检查保护。
 *
 * 返回 JSON 字符串(由 Runtime.evaluate 的 returnByValue 带回)。
 * 坐标一律是**视口坐标系**的 CSS 像素,可直接喂给 Input.dispatchMouseEvent。
 */
export const COLLECT_SCRIPT = String.raw`
(() => {
  const OPTS = __OPTIONS__;
  const MAX = OPTS.maxElements || 300;
  const MAX_TEXT = OPTS.maxTextLength || 120;
  const VIEWPORT_ONLY = OPTS.viewportOnly !== false;

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]',
    '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[role="slider"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const TAG_ROLE = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
    summary: 'button', option: 'option'
  };

  const clip = (s) => {
    if (!s) return '';
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return TAG_ROLE[tag] || tag;
  };

  /** 可访问名称:按 aria > label > placeholder > alt/title > 自身文本 的优先级 */
  const nameOf = (el, root) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return clip(aria);

    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map((id) => { try { return root.getElementById ? root.getElementById(id) : null; } catch (e) { return null; } })
        .filter(Boolean)
        .map((n) => n.textContent || '');
      if (parts.length) return clip(parts.join(' '));
    }

    if (el.labels && el.labels.length) {
      const t = clip(el.labels[0].textContent);
      if (t) return t;
    }

    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return clip(ph);

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      // 按钮型 input 的可见文字就是 value
      if (t === 'submit' || t === 'button' || t === 'reset') {
        const v = el.getAttribute('value');
        if (v) return clip(v);
      }
    }

    const alt = el.getAttribute && el.getAttribute('alt');
    if (alt) return clip(alt);

    // 内含图标图片时借用图片的 alt
    const img = el.querySelector && el.querySelector('img[alt]:not([alt=""])');
    if (img) {
      const t = clip(img.getAttribute('alt'));
      if (t) return t;
    }

    const own = clip(el.innerText || el.textContent);
    if (own) return own;

    const title = el.getAttribute && el.getAttribute('title');
    if (title) return clip(title);

    return '';
  };

  const valueOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      // 不把用户输入的密码带出页面
      if (t === 'password') return el.value ? '***' : '';
      if (t === 'checkbox' || t === 'radio') return undefined;
      if (t === 'submit' || t === 'button' || t === 'reset') return undefined;
      return clip(el.value);
    }
    if (tag === 'textarea') return clip(el.value);
    if (tag === 'select') {
      const o = el.options && el.options[el.selectedIndex];
      return o ? clip(o.textContent) : '';
    }
    if (el.isContentEditable) return clip(el.innerText);
    return undefined;
  };

  /**
   * xpath 只在元素与 document 之间不跨 shadow root / iframe 时才有意义,
   * 否则返回 null,由调用方改用 center 坐标定位。
   */
  const xpathOf = (el, crossedBoundary) => {
    if (crossedBoundary) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const parent = node.parentNode;
      if (!parent || parent.nodeType === 11) return null; // 撞到 shadow root
      let i = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + i + ']');
      if (parent.nodeType === 9) break; // document
      node = parent;
    }
    return parts.length ? '/' + parts.join('/') : null;
  };

  const isVisible = (el, win) => {
    let style;
    try { style = win.getComputedStyle(el); } catch (e) { return false; }
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  };

  const results = [];
  let truncated = false;
  const seen = new Set();

  /**
   * 遍历一个文档/shadow root。
   * offset 把 iframe 内的局部坐标平移到顶层视口坐标系。
   */
  const walk = (root, win, offset, frameLabel, crossedBoundary, depth) => {
    if (depth > 12 || results.length >= MAX) return;

    let nodes;
    try { nodes = root.querySelectorAll('*'); } catch (e) { return; }

    for (const el of nodes) {
      if (results.length >= MAX) { truncated = true; return; }
      if (seen.has(el)) continue;

      // 先下潜 shadow root:宿主自身未必可交互,内部却常常是真正的控件
      if (el.shadowRoot) {
        seen.add(el);
        walk(el.shadowRoot, win, offset, frameLabel, true, depth + 1);
        if (results.length >= MAX) { truncated = true; return; }
      }

      const tag = el.tagName.toLowerCase();

      // 同源 iframe:带偏移递归;跨源的拿不到 contentDocument,只能跳过
      if (tag === 'iframe' || tag === 'frame') {
        seen.add(el);
        let doc = null;
        try { doc = el.contentDocument; } catch (e) { doc = null; }
        if (doc) {
          const r = el.getBoundingClientRect();
          const label = (frameLabel ? frameLabel + ' > ' : '') +
            'iframe' + (el.getAttribute('name') ? '[' + el.getAttribute('name') + ']' :
                        el.getAttribute('src') ? '[' + clip(el.getAttribute('src')) + ']' : '');
          walk(doc, el.contentWindow || win, { x: offset.x + r.left, y: offset.y + r.top }, label, true, depth + 1);
        }
        continue;
      }

      let matches = false;
      try { matches = el.matches(INTERACTIVE); } catch (e) { matches = false; }
      if (!matches) continue;

      seen.add(el);
      if (!isVisible(el, win)) continue;

      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const x = r.left + offset.x;
      const y = r.top + offset.y;
      const cx = x + r.width / 2;
      const cy = y + r.height / 2;

      const inViewport = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
      if (VIEWPORT_ONLY && !inViewport) continue;

      const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
      const ariaExpanded = el.getAttribute('aria-expanded');

      const item = {
        index: results.length,
        tag: tag,
        role: roleOf(el),
        name: nameOf(el, root),
        bbox: { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height) },
        center: { x: Math.round(cx), y: Math.round(cy) },
        inViewport: inViewport,
        xpath: xpathOf(el, crossedBoundary),
        frame: frameLabel
      };

      const type = el.getAttribute && el.getAttribute('type');
      if (type) item.type = type.toLowerCase();
      const v = valueOf(el);
      if (v !== undefined) item.value = v;
      if (tag === 'a' && el.getAttribute('href')) item.href = clip(el.href || el.getAttribute('href'));
      if (disabled) item.disabled = true;
      if (typeof el.checked === 'boolean' && (item.role === 'checkbox' || item.role === 'radio' || item.role === 'switch')) {
        item.checked = el.checked;
      }
      if (ariaExpanded !== null && ariaExpanded !== undefined) item.expanded = ariaExpanded === 'true';

      results.push(item);
    }
  };

  walk(document, window, { x: 0, y: 0 }, null, false, 0);

  const se = document.scrollingElement || document.documentElement;
  const scrollY = se ? se.scrollTop : 0;
  const scrollX = se ? se.scrollLeft : 0;
  const scrollHeight = se ? se.scrollHeight : 0;

  return JSON.stringify({
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: Math.round(scrollHeight) },
    hasContentAbove: scrollY > 1,
    hasContentBelow: scrollHeight - scrollY - window.innerHeight > 1,
    elements: results,
    truncated: truncated
  });
})()
`
