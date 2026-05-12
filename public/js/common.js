(() => {
  window.SKULL_IMG_SRC = '/img/skull.png';
  window.SKULL_SVG = `<img src="/img/skull.png" alt="" aria-hidden="true" style="width:100%;height:100%;object-fit:contain;display:block;" />`;
  window.SKULL_LARGE = `<img src="/img/skull.png" alt="" aria-hidden="true" style="width:100%;height:100%;object-fit:contain;display:block;" />`;

  window.HEART_SVG = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 21s-7-4.35-9.5-9C1 8 3.5 4 7.5 4c2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20.5 4 23 8 21.5 12c-2.5 4.65-9.5 9-9.5 9z"/>
    </svg>`;

  window.MENU_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7h16M4 12h16M4 17h16" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  window.CLOSE_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 6l12 12M18 6L6 18" stroke-width="1.6" stroke-linecap="round"/></svg>`;

  window.toast = (msg, ms = 2200) => {
    let n = document.querySelector('.notice');
    if (!n) { n = document.createElement('div'); n.className = 'notice'; document.body.appendChild(n); }
    n.textContent = msg;
    requestAnimationFrame(() => n.classList.add('show'));
    clearTimeout(n._t);
    n._t = setTimeout(() => n.classList.remove('show'), ms);
  };

  window.api = async (url, opts = {}) => {
    const init = { headers: { 'Content-Type': 'application/json' }, ...opts };
    if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
    const res = await fetch(url, init);
    let data; try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  window.formatDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  };

  window.timeUntil = (iso) => {
    if (!iso) return 'never';
    const ms = new Date(iso) - Date.now();
    if (ms < 0) return 'expired';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)}d`;
    if (h > 0)  return `${h}h ${m}m`;
    return `${m}m`;
  };

  window.escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  window.mountNav = async (active) => {
    let me = null;
    try { const s = await api('/api/session'); me = s.user; } catch {}

    const links = [
      { href: '/dashboard', label: 'Home' },
      { href: '/games',     label: 'Games' },
      { href: '/scripts',   label: 'Scripts' }
    ];
    if (me && me.kind === 'dev') {
      links.push({ href: '/dev',       label: 'Developer' });
      links.push({ href: '/drops',     label: 'Drops' });
      links.push({ href: '/obfuscate', label: 'Obfuscate' });
      links.push({ href: '/logs',      label: 'Logs' });
    }
    
    if (me && me.isMorph) {
      links.push({ href: '/morphs', label: 'Morphs' });
    }
    if (me && me.kind === 'dev' && me.isOwner) {
      links.push({ href: '/owner', label: 'Owner' });
      links.push({ href: '/audit', label: 'Audit' });
    }

    const linkHtml = links.map(l => `<li><a href="${l.href}" class="${l.href === active ? 'active' : ''}">${l.label}</a></li>`).join('');

    const html = `
      <nav class="nav">
        <a href="/dashboard" class="nav-brand">
          <span class="skull-mark">${SKULL_SVG}</span>
          <span>skullsploit</span>
        </a>
        <ul class="nav-links">${linkHtml}</ul>
        <div class="nav-meta nav-meta-desktop">
          ${me ? `<span class="dim">${escapeHtml(me.username)}</span>` : ''}
          <button class="btn-ghost" id="nav-logout">sign out</button>
        </div>
        <button class="nav-toggle" id="nav-toggle" aria-label="Open menu">${MENU_SVG}</button>
      </nav>

      <div class="nav-drawer" id="nav-drawer" role="dialog" aria-label="Menu">
        <div class="nav-drawer-head">
          <span class="nav-brand">
            <span class="skull-mark">${SKULL_SVG}</span>
            <span>skullsploit</span>
          </span>
          <button class="nav-toggle" id="nav-close">${CLOSE_SVG}</button>
        </div>
        <ul class="nav-drawer-links">${linkHtml}</ul>
        <div class="nav-drawer-foot">
          <span>${me ? escapeHtml(me.username) : ''}</span>
          <button id="nav-logout-2">sign out</button>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('afterbegin', html);

    const drawer = document.getElementById('nav-drawer');
    document.getElementById('nav-toggle').onclick = () => drawer.classList.add('open');
    document.getElementById('nav-close').onclick  = () => drawer.classList.remove('open');

    const doLogout = async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      window.location.href = '/';
    };
    document.getElementById('nav-logout').onclick = doLogout;
    document.getElementById('nav-logout-2').onclick = doLogout;
  };

  window.mountFooter = () => {
    const html = `
      <footer class="foot">
        <span>© skullsploit</span>
        <span class="muted">a serverside for skids.</span>
      </footer>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.requireSession = async (kind) => {
    try {
      const s = await api('/api/session');
      if (!s.user) { window.location.href = '/'; return null; }
      if (kind === 'dev' && s.user.kind !== 'dev') { window.location.href = '/dashboard'; return null; }
      return s.user;
    } catch { window.location.href = '/'; return null; }
  };
})();
